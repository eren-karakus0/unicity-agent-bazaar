import path from 'node:path';
import {
  Sphere,
  getCoinIdBySymbol,
  getTokenDecimals,
  parseTokenAmount,
  toHumanReadable,
} from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

const UCT = 'UCT';
const DEFAULT_UCT_DECIMALS = 18;

export interface WalletConfig {
  mnemonic: string;
  nametag: string;
  dataDir: string;
  oracleApiKey: string;
  walletApiUrl: string;
}

/**
 * The MCP agent's own Sphere wallet - it proves identity (Sign-In-With-Wallet)
 * and funds escrows on testnet2. A trimmed mirror of the backend's SphereAgent:
 * same two-step v2 provider wiring, exposing only what the MCP tools need.
 */
export class McpWallet {
  private sphere: Sphere | null = null;
  private coinIdHex = UCT;
  private decimals: number | undefined;

  constructor(private readonly cfg: WalletConfig) {}

  async start(): Promise<void> {
    const base = createNodeProviders({
      network: 'testnet2',
      dataDir: this.cfg.dataDir,
      tokensDir: path.join(this.cfg.dataDir, 'tokens'),
      oracle: { apiKey: this.cfg.oracleApiKey },
    });
    const providers = createWalletApiProviders(base, {
      baseUrl: this.cfg.walletApiUrl,
      network: 'testnet2',
      deviceId: 'bazaar-mcp',
    });
    const { sphere } = await Sphere.init({
      ...providers,
      network: 'testnet2',
      nametag: this.cfg.nametag.replace(/^@/, ''),
      mnemonic: this.cfg.mnemonic,
    });
    this.sphere = sphere;
    this.coinIdHex = getCoinIdBySymbol(UCT) ?? UCT;
    try {
      this.decimals = getTokenDecimals(this.coinIdHex);
    } catch {
      this.decimals = undefined;
    }
  }

  private get s(): Sphere {
    if (!this.sphere) throw new Error('wallet not started');
    return this.sphere;
  }

  get chainPubkey(): string {
    return this.s.identity?.chainPubkey ?? '';
  }
  get nametag(): string | undefined {
    return this.s.getNametag() ?? undefined;
  }
  /** Sign a plaintext with the wallet identity key (matches verifySignedMessage). */
  signMessage(message: string): string {
    return this.s.signMessage(message);
  }

  async send(recipient: string, human: string | number, memo?: string): Promise<unknown> {
    const amount = parseTokenAmount(String(human), this.decimals).toString();
    return this.s.payments.send({
      coinId: this.coinIdHex,
      amount,
      recipient,
      ...(memo ? { memo } : {}),
    });
  }

  async balanceUct(): Promise<string> {
    const uctHex = getCoinIdBySymbol(UCT);
    const assets = await this.s.payments.getAssets();
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
    return toHumanReadable(total, this.decimals);
  }

  async stop(): Promise<void> {
    if (this.sphere) {
      await this.sphere.destroy();
      this.sphere = null;
    }
  }
}
