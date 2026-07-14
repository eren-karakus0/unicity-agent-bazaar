/**
 * AutonomousPatron - a first-party buyer that closes the machine-economy loop.
 *
 * It runs headless with its OWN wallet (separate from the escrow), signs in to
 * the bazaar, then on a timer: discovers listings, picks one, and hires it end
 * to end - funding the escrow with real testnet UCT, waiting for delivery, and
 * releasing - with no human in the loop. The whole point of the platform, made
 * continuously, visibly true.
 *
 * It reuses the exact same buyer surface a third party would: the `BazaarClient`
 * from @bazaar/agent-kit, driven by a wallet-backed `Signer` + `Funder`. Every
 * cycle is best-effort and fully isolated - a failure logs a warning and never
 * touches the backend it runs beside. The wallet + buyer are injectable so the
 * loop is unit-tested without a network or a real wallet.
 */
import path from 'node:path';
import {
  BazaarClient,
  type Funder,
  type JobView,
  type ListingLite,
  type Signer,
} from '@bazaar/agent-kit';
import { SphereAgent } from './sphere-agent.js';
import { principalOf, normalizeNametag } from './auth.js';
import { createLogger, type Logger } from './logger.js';
import type { NetworkType } from './config.js';

/** The wallet surface the patron needs (satisfied by SphereAgent). */
export interface PatronWallet {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  signMessage(message: string): string;
  send(recipient: string, human: string | number, memo?: string): Promise<unknown>;
  mintUct(human: string | number): Promise<unknown>;
  balanceUct(): Promise<string>;
  readonly chainPubkey?: string;
  readonly nametag: string;
}

/** The buyer surface the patron drives (satisfied by BazaarClient). */
export interface PatronBuyer {
  login(): Promise<void>;
  listings(): Promise<ListingLite[]>;
  hireAndSettle(listingId: string, input: unknown, opts?: { timeoutMs?: number }): Promise<JobView>;
}

export interface PatronOptions {
  mnemonic: string;
  nametag: string;
  /** Gap between hire cycles (ms). */
  intervalMs: number;
  /** The bazaar backend to buy from - loopback to this process. */
  baseUrl: string;
  dataDir: string;
  network: NetworkType;
  oracleApiKey: string;
  walletApiUrl: string;
  /** Mint more when the spendable balance drops below this (default 25 UCT). */
  minBalanceUct?: number;
  /** Amount minted when topping up (default 100 UCT). */
  mintUct?: number;
  /** Skip listings priced above this, so one bad cycle can't drain the wallet (default 50). */
  maxPriceUct?: number;
  logger?: Logger;
  /** Test seam: inject a wallet instead of building a real Sphere one. */
  wallet?: PatronWallet;
  /** Test seam: inject a buyer instead of building a real BazaarClient. */
  buyer?: PatronBuyer;
}

/** A compact, pollable summary of the patron's autonomous activity. */
export interface PatronStats {
  cycles: number;
  hires: number;
  lastAt: number | null;
  /** Gap between hire cycles — lets the UI show an honest "next hire" ETA. */
  intervalMs: number;
  lastListing?: string;
  lastState?: string;
  lastError?: string;
}

export class AutonomousPatron {
  private readonly opts: PatronOptions;
  private readonly log: Logger;
  private agent: PatronWallet | null = null;
  private client: PatronBuyer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private cursor = 0;
  private principal_: string | null = null;

  // Rolling activity summary (the job feed itself is read from BazaarService).
  private cycles = 0;
  private hires = 0;
  private lastAt: number | null = null;
  private lastListing?: string;
  private lastState?: string;
  private lastError?: string;

  constructor(opts: PatronOptions) {
    this.opts = opts;
    this.log = opts.logger ?? createLogger('patron');
  }

  /** The buyer principal exactly as BazaarService keys it (matches job.buyerNametag). */
  get principal(): string | null {
    return this.principal_;
  }
  get nametag(): string | null {
    return this.agent?.nametag ?? null;
  }

  stats(): PatronStats {
    return {
      cycles: this.cycles,
      hires: this.hires,
      lastAt: this.lastAt,
      intervalMs: this.opts.intervalMs,
      ...(this.lastListing ? { lastListing: this.lastListing } : {}),
      ...(this.lastState ? { lastState: this.lastState } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /**
   * Bring the wallet + buyer online and sign in, WITHOUT scheduling the loop.
   * Returns false if the wallet has no usable identity. Resilient: a failed
   * initial login is retried automatically on the first hire (401 → re-auth).
   */
  async bootstrap(): Promise<boolean> {
    this.agent =
      this.opts.wallet ??
      new SphereAgent({
        name: 'patron',
        nametag: this.opts.nametag,
        dataDir: path.join(this.opts.dataDir, 'patron'),
        network: this.opts.network,
        oracleApiKey: this.opts.oracleApiKey,
        walletApiUrl: this.opts.walletApiUrl,
        mnemonic: this.opts.mnemonic,
        mnemonicEnvHint: 'PATRON_MNEMONIC',
        deviceId: 'bazaar-patron',
        logger: createLogger('patron-wallet'),
      });
    await this.agent.start();
    const chainPubkey = this.agent.chainPubkey;
    if (!chainPubkey) {
      this.log.warn('patron wallet has no chain pubkey - autonomous buyer disabled');
      return false;
    }
    // Mirror exactly how the server derives the principal at login, so the
    // showcase can find the patron's jobs (job.buyerNametag === this.principal).
    const tag = normalizeNametag(this.agent.nametag);
    this.principal_ = principalOf({ chainPubkey, ...(tag ? { nametag: tag } : {}) });

    if (this.opts.buyer) {
      this.client = this.opts.buyer;
    } else {
      const signer: Signer = {
        chainPubkey,
        ...(this.agent.nametag ? { nametag: this.agent.nametag } : {}),
        sign: (message: string) => this.agent!.signMessage(message),
      };
      const funder: Funder = async (to, amountUct, memo) => {
        await this.agent!.send(to, amountUct, memo);
      };
      this.client = new BazaarClient(this.opts.baseUrl, { signer, funder });
    }
    try {
      await this.client.login();
      this.log.info(`autonomous patron signed in as ${this.principal_}`);
    } catch (e) {
      this.log.warn(`patron initial sign-in failed (will retry on first hire): ${errMsg(e)}`);
    }
    return true;
  }

  /** Bootstrap and start the recurring hire loop (production entry point). */
  async start(): Promise<void> {
    const ok = await this.bootstrap();
    if (!ok || !this.client) return;
    const everySec = Math.round(this.opts.intervalMs / 1000);
    this.log.info(`autonomous patron online - hiring an agent every ${everySec}s`);
    // First cycle shortly after boot (let house agents finish seeding), then steady.
    setTimeout(() => void this.runCycle(), Math.min(20_000, this.opts.intervalMs));
    this.timer = setInterval(() => void this.runCycle(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  /** One autonomous purchase: top up, discover, pick, hire end-to-end. Never throws. */
  async runCycle(): Promise<void> {
    if (!this.client || this.busy) return;
    this.busy = true;
    this.cycles += 1;
    try {
      await this.ensureFunds();
      const listings = await this.client.listings();
      const target = this.pickTarget(listings);
      if (!target) {
        this.log.info('patron: no hireable listing available yet');
        return;
      }
      this.log.info(`patron hiring "${target.title}" (${target.priceUct} UCT)…`);
      const view = await this.client.hireAndSettle(target.id, this.inputFor(target), { timeoutMs: 120_000 });
      this.hires += 1;
      this.lastAt = Date.now();
      this.lastListing = target.title;
      this.lastState = view.job.state;
      this.lastError = undefined;
      this.log.info(`patron job ${view.job.jobId} → ${view.job.state}`);
    } catch (e) {
      this.lastError = errMsg(e);
      this.log.warn(`patron cycle failed: ${this.lastError}`);
    } finally {
      this.busy = false;
    }
  }

  /** Keep the wallet spendable so a hire never stalls on funding. */
  private async ensureFunds(): Promise<void> {
    if (!this.agent) return;
    try {
      const balance = Number(await this.agent.balanceUct());
      const floor = this.opts.minBalanceUct ?? 25;
      if (balance < floor) {
        const mint = this.opts.mintUct ?? 100;
        this.log.info(`patron balance ${balance} UCT - minting ${mint}`);
        await this.agent.mintUct(mint);
      }
    } catch (e) {
      this.log.warn(`patron balance check failed: ${errMsg(e)}`);
    }
  }

  /** Rotate through hireable listings (not the patron's own, within a price cap). */
  private pickTarget(listings: ListingLite[]): ListingLite | undefined {
    const maxPrice = this.opts.maxPriceUct ?? 50;
    const pool = listings.filter(
      (l) => l.agentNametag !== this.principal_ && (l.priceUct ?? 0) <= maxPrice,
    );
    if (pool.length === 0) return undefined;
    const pick = pool[this.cursor % pool.length];
    this.cursor += 1;
    return pick;
  }

  /** A sensible input for a listing, by category (schema-agnostic, always valid). */
  private inputFor(listing: ListingLite): unknown {
    const category = (listing.category ?? '').toLowerCase();
    if (category === 'game') return { sides: 6, rolls: 3 };
    return {
      text:
        'The Unicity machine economy lets autonomous agents discover, hire, and pay each ' +
        'other on-chain. This request was generated automatically by the Patron agent - ' +
        'no human in the loop.',
    };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.agent?.stop().catch(() => undefined);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
