import path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  Sphere,
  getCoinIdBySymbol,
  getTokenDecimals,
  parseTokenAmount,
  toHumanReadable,
} from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';
import { Logger, createLogger } from './logger.js';
import type { NetworkType } from './config.js';

const UCT = 'UCT';
/** SDK default when a token's decimals can't be resolved (mirrors DEFAULT_TOKEN_DECIMALS). */
const DEFAULT_UCT_DECIMALS = 18;

export interface SphereAgentOptions {
  /** Logical name, e.g. 'escrow' — used for logs, deviceId, data dir. */
  name: string;
  /** Desired on-network @nametag (without the @). */
  nametag: string;
  /** Absolute path for this agent's wallet + token storage. */
  dataDir: string;
  network?: NetworkType;
  oracleApiKey: string;
  walletApiUrl: string;
  deviceId?: string;
  /** Optional mnemonic; if absent a new wallet is auto-generated. */
  mnemonic?: string;
  /** Env var name to suggest in the "new wallet" log (defaults to NAME_MNEMONIC). */
  mnemonicEnvHint?: string;
  logger?: Logger;
}

/**
 * SphereAgent — a thin, reusable wrapper around a single Sphere v2 wallet.
 *
 * It performs the two-step v2 provider wiring (base providers + wallet-api
 * rails — the step that silently breaks transfers if skipped) and exposes the
 * economic primitives the platform needs: mint, send, history, balance.
 */
export class SphereAgent {
  readonly name: string;
  readonly desiredNametag: string;
  readonly log: Logger;

  private readonly opts: SphereAgentOptions;
  private inner: Sphere | null = null;
  private uctCoinId = UCT;
  private uctDecimals: number | undefined;

  constructor(opts: SphereAgentOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.desiredNametag = opts.nametag.replace(/^@/, '');
    this.log = opts.logger ?? createLogger(opts.name);
  }

  get sphere(): Sphere {
    if (!this.inner) throw new Error(`[${this.name}] agent not started — call start() first`);
    return this.inner;
  }

  async start(): Promise<{ created: boolean; mnemonic?: string }> {
    // This wrapper targets testnet2 end-to-end (the wallet-api rails and
    // Sphere.init below are testnet2); 'testnet' is the SDK's alias for it.
    // Normalize so the base providers can't drift onto a different network id.
    const network: NetworkType =
      this.opts.network === 'testnet' ? 'testnet2' : (this.opts.network ?? 'testnet2');
    const base = createNodeProviders({
      network,
      dataDir: this.opts.dataDir,
      tokensDir: path.join(this.opts.dataDir, 'tokens'),
      oracle: { apiKey: this.opts.oracleApiKey },
    });
    const providers = createWalletApiProviders(base, {
      baseUrl: this.opts.walletApiUrl,
      network: 'testnet2',
      deviceId: this.opts.deviceId ?? `bazaar-${this.name}`,
    });

    const common = {
      ...providers,
      network: 'testnet2' as const,
      nametag: this.desiredNametag,
    };
    const initOptions = this.opts.mnemonic
      ? { ...common, mnemonic: this.opts.mnemonic }
      : { ...common, autoGenerate: true as const };

    this.log.info(`starting wallet @${this.desiredNametag} on ${network}…`);
    const { sphere, created, generatedMnemonic } = await Sphere.init(initOptions);
    this.inner = sphere;

    this.uctCoinId = getCoinIdBySymbol(UCT) ?? UCT;
    try {
      this.uctDecimals = getTokenDecimals(this.uctCoinId);
    } catch {
      this.uctDecimals = undefined;
    }

    this.log.info(`ready — @${this.nametag}  addr=${this.directAddress?.slice(0, 24)}…`);
    if (created && generatedMnemonic) {
      // Never print a live mnemonic to stdout/stderr — hosting logs are retained
      // and often exportable. Persist it beside the wallet's own key storage (the
      // dataDir already holds secrets and is gitignored) and log only the path.
      const secretPath = path.join(this.opts.dataDir, 'mnemonic.txt');
      const envKey = this.opts.mnemonicEnvHint ?? `${this.name.toUpperCase()}_MNEMONIC`;
      try {
        writeFileSync(secretPath, `${generatedMnemonic}\n`, { encoding: 'utf8', mode: 0o600 });
        this.log.warn(`NEW wallet generated — mnemonic written to ${secretPath}. Copy it into .env as ${envKey}, then delete the file.`);
      } catch {
        this.log.warn(`NEW wallet generated — set ${envKey} in .env (mnemonic withheld from logs).`);
      }
    }
    return { created, mnemonic: generatedMnemonic };
  }

  get nametag(): string {
    return this.inner?.getNametag() ?? this.desiredNametag;
  }
  get directAddress(): string | undefined {
    return this.inner?.identity?.directAddress;
  }
  get chainPubkey(): string | undefined {
    return this.inner?.identity?.chainPubkey;
  }

  /** UCT coin id (hex) + decimals — e.g. for building wallet send-intents. */
  get uctCoin(): { coinId: string; decimals: number } {
    return { coinId: this.uctCoinId, decimals: this.uctDecimals ?? DEFAULT_UCT_DECIMALS };
  }

  // ---- amount helpers (human UCT string/number <-> smallest-unit) ----
  toSmallest(human: string | number): string {
    return parseTokenAmount(String(human), this.uctDecimals).toString();
  }
  toHuman(smallest: bigint | string): string {
    return toHumanReadable(smallest, this.uctDecimals);
  }

  // ---- payments ----
  async mintUct(human: string | number) {
    const amount = parseTokenAmount(String(human), this.uctDecimals);
    const coinIdHex = getCoinIdBySymbol(UCT) ?? this.uctCoinId;
    this.log.info(`self-minting ${human} UCT (coinId ${coinIdHex.slice(0, 10)}…)…`);
    return this.sphere.payments.mintFungibleToken(coinIdHex, amount);
  }

  async send(recipient: string, human: string | number, memo?: string) {
    const to = this.normalizeRecipient(recipient);
    this.log.info(`sending ${human} UCT → ${to.slice(0, 28)}…`);
    return this.sphere.payments.send({
      coinId: this.uctCoinId,
      amount: this.toSmallest(human),
      recipient: to,
      ...(memo ? { memo } : {}),
    });
  }

  /**
   * The wallet's transaction history (newest first). This is the reliable way
   * to observe INCOMING transfers: the wallet-api rails deliver tokens in the
   * background (receive() callbacks never fire for them), but every delivery
   * lands here as a RECEIVED entry with sender pubkey/nametag + memo.
   */
  getHistory(): unknown[] {
    return this.sphere.payments.getHistory();
  }

  /** Confirmed (spendable) UCT balance, as a human-readable string. */
  async balanceUct(): Promise<string> {
    const uctHex = getCoinIdBySymbol(UCT);
    const assets = await this.sphere.payments.getAssets();
    let total = 0n;
    for (const a of assets) {
      if (a.symbol === UCT || a.coinId === uctHex) {
        try {
          total += BigInt(a.confirmedAmount || a.totalAmount || '0');
        } catch {
          /* ignore */
        }
      }
    }
    return this.toHuman(total);
  }

  private normalizeRecipient(recipient: string): string {
    if (recipient.startsWith('@') || recipient.includes('://')) return recipient;
    if (/^0[23][0-9a-fA-F]{64}$/.test(recipient)) return recipient; // chain pubkey
    return `@${recipient}`;
  }

  async stop(): Promise<void> {
    if (this.inner) {
      await this.inner.destroy();
      this.inner = null;
    }
  }
}
