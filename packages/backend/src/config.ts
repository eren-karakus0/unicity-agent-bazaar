import { config as loadDotenv } from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type NetworkType = 'mainnet' | 'testnet' | 'testnet2' | 'dev';

/** Public testnet2 gateway key (NOT a secret - documented in the SDK README). */
export const PUBLIC_TESTNET2_KEY = 'sk_ddc3cfcc001e4a28ac3fad7407f99590';
export const DEFAULT_WALLET_API_URL = 'https://wallet-api.unicity.network';

export interface BazaarEnv {
  network: NetworkType;
  oracleApiKey: string;
  walletApiUrl: string;
  /** The platform's autonomous escrow agent. */
  escrow: { nametag: string; mnemonic?: string };
  /** Broadcast listings to / read from Unicity's decentralized market feed. */
  market: boolean;
  /** Public base URL of this deployment (woven into posted market intents). */
  publicUrl?: string;
  port: number;
  /** How long a delivered job waits before it auto-releases to the provider. */
  autoReleaseMs: number;
  /** Absolute path to <repoRoot>/data. */
  dataRoot: string;
  /** Auth: HMAC secret for session tokens, login lifetime, dispute operators. */
  auth: {
    sessionSecret: string;
    sessionTtlMs: number;
    secretIsEphemeral: boolean;
    /** Chain pubkeys allowed to resolve disputes (empty = dispute resolution disabled). */
    operators: string[];
  };
}

/** Walk up from `start` until a directory containing pnpm-workspace.yaml is found. */
export function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return start;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(moduleDir);

// Load .env from the repo root regardless of which package's cwd we run from.
loadDotenv({ path: path.join(repoRoot, '.env') });

export function loadEnv(): BazaarEnv {
  const clean = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t && t.length > 0 ? t : undefined;
  };
  const autoReleaseMin = Number(clean(process.env.BAZAAR_AUTO_RELEASE_MINUTES) ?? '2');

  // Session secret: prefer a configured one (so tokens survive restarts /
  // multiple instances). If none is set, fall back to a random per-boot secret
  // - logins still work, but every restart invalidates existing sessions.
  const configuredSecret = clean(process.env.BAZAAR_SESSION_SECRET);
  const sessionSecret = configuredSecret ?? crypto.randomBytes(32).toString('hex');
  const sessionTtlMin = Number(clean(process.env.BAZAAR_SESSION_TTL_MINUTES) ?? String(24 * 60));
  const operators = (clean(process.env.BAZAAR_OPERATOR_PUBKEYS) ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0[23][0-9a-f]{64}$/.test(s));

  return {
    network: (clean(process.env.SPHERE_NETWORK) as NetworkType) ?? 'testnet2',
    oracleApiKey: clean(process.env.SPHERE_ORACLE_API_KEY) ?? PUBLIC_TESTNET2_KEY,
    walletApiUrl: clean(process.env.SPHERE_WALLET_API_URL) ?? DEFAULT_WALLET_API_URL,
    escrow: {
      nametag: clean(process.env.BAZAAR_ESCROW_NAMETAG) ?? 'bazaar-escrow-knkchn',
      mnemonic: clean(process.env.BAZAAR_ESCROW_MNEMONIC),
    },
    // Market feed defaults ON; set BAZAAR_MARKET=0 to disable (e.g. offline dev).
    market: !/^(0|false|off|no)$/i.test(clean(process.env.BAZAAR_MARKET) ?? '1'),
    publicUrl: clean(process.env.BAZAAR_PUBLIC_URL),
    port: Number(clean(process.env.PORT) ?? clean(process.env.BACKEND_PORT) ?? '4600'),
    autoReleaseMs: Math.max(1, autoReleaseMin) * 60_000,
    dataRoot: path.join(repoRoot, 'data'),
    auth: {
      sessionSecret,
      sessionTtlMs: Math.max(5, sessionTtlMin) * 60_000,
      secretIsEphemeral: !configuredSecret,
      operators,
    },
  };
}
