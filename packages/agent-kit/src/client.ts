import type { InputField, SignedReceipt } from '@bazaar/core';

/**
 * A client for the Agent Bazaar HTTP API - the piece that lets an agent be a
 * *buyer* as well as a provider. With it, a provider handler can sub-hire other
 * listed agents mid-job (nested escrow), the core "agents hiring agents" loop.
 *
 * Auth (wallet signature) and payment (UCT transfer) are injected, so this stays
 * free of any specific wallet SDK: pass a `signer` to prove identity and a
 * `funder` to move funds into escrow.
 */

export interface ListingLite {
  id: string;
  slug: string;
  agentNametag: string;
  title: string;
  description: string;
  category: string;
  priceUct: number;
  inputSchema?: InputField[];
  verified?: boolean;
  avgRating?: number | null;
  ratingCount?: number;
  jobsCompleted?: number;
  successRate?: number;
  favorites?: number;
}

export interface HireResult {
  job: { jobId: string; escrowRef: string; state: string; amountUct: number };
  payTo: string;
  memo: string;
  amountUct: number;
  coinId: string;
  decimals: number;
}

export interface JobView {
  job: {
    jobId: string;
    escrowRef: string;
    listingId: string;
    state: string;
    amountUct: number;
    updatedAt: number;
  };
  result?: { ok: boolean; output?: unknown; error?: string };
  settlement?: { status: string; kind: string; amountUct: number; recipient: string; txId?: string };
  receipt?: SignedReceipt;
  parentJobId?: string;
  children?: string[];
}

export interface DepositInfo {
  escrow: string;
  coinId: string;
  decimals: number;
  symbol: string;
}

export interface Challenge {
  nonce: string;
  message: string;
  expiresAt: number;
}

/** Proves wallet ownership - signs the login challenge. */
export interface Signer {
  chainPubkey: string;
  nametag?: string;
  sign: (message: string) => string;
}

/** Moves `amountUct` into escrow with the given memo (a wallet transfer). */
export type Funder = (to: string, amountUct: number, memo: string) => Promise<void>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const TERMINAL = new Set(['released', 'refunded', 'cancelled']);

export interface BazaarClientOptions {
  signer?: Signer;
  funder?: Funder;
  fetchImpl?: typeof fetch;
}

export class BazaarClient {
  private token: string | null = null;
  private readonly signer?: Signer;
  private readonly funder?: Funder;
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    opts: BazaarClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.signer = opts.signer;
    this.funder = opts.funder;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  get canBuy(): boolean {
    return !!this.signer && !!this.funder;
  }

  // ---- reads ----
  async listings(): Promise<ListingLite[]> {
    return (await this.get<{ listings: ListingLite[] }>('/api/listings')).listings;
  }
  async listing(id: string): Promise<ListingLite> {
    return (await this.get<{ listing: ListingLite }>(`/api/listings/${encodeURIComponent(id)}`)).listing;
  }
  async depositInfo(): Promise<DepositInfo> {
    return this.get<DepositInfo>('/api/deposit-info');
  }
  async job(jobId: string): Promise<JobView> {
    return this.get<JobView>(`/api/jobs/${encodeURIComponent(jobId)}`);
  }

  // ---- actions ----
  async hire(
    listingId: string,
    input: unknown,
    opts: { parentJobId?: string; mandateId?: string } = {},
  ): Promise<HireResult> {
    return this.post<HireResult>('/api/hire', {
      listingId,
      input,
      ...(opts.parentJobId ? { parentJobId: opts.parentJobId } : {}),
      ...(opts.mandateId ? { mandateId: opts.mandateId } : {}),
    });
  }
  async accept(jobId: string): Promise<JobView['job']> {
    return (await this.post<{ job: JobView['job'] }>(`/api/jobs/${encodeURIComponent(jobId)}/accept`, {})).job;
  }
  async dispute(jobId: string): Promise<JobView['job']> {
    return (await this.post<{ job: JobView['job'] }>(`/api/jobs/${encodeURIComponent(jobId)}/dispute`, {})).job;
  }

  /** Fund a quoted job's escrow from the wallet (needs a funder). */
  async pay(jobId: string): Promise<void> {
    if (!this.funder) throw new Error('no funder configured - cannot pay escrow');
    const view = await this.job(jobId);
    if (view.job.state !== 'quoted') return;
    const dep = await this.depositInfo();
    await this.funder(dep.escrow, view.job.amountUct, view.job.escrowRef);
  }

  /**
   * The one-call sub-hire: open escrow, fund it, wait for the provider to
   * deliver, optionally accept, and return the final job (with its output).
   * Pass `parentJobId` to record the nested-escrow lineage.
   */
  async hireAndSettle(
    listingId: string,
    input: unknown,
    opts: {
      parentJobId?: string;
      mandateId?: string;
      pollMs?: number;
      timeoutMs?: number;
      autoAccept?: boolean;
    } = {},
  ): Promise<JobView> {
    if (!this.canBuy) throw new Error('sub-hiring needs both a signer and a funder');
    const pollMs = opts.pollMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
    const hired = await this.hire(listingId, input, {
      ...(opts.parentJobId ? { parentJobId: opts.parentJobId } : {}),
      ...(opts.mandateId ? { mandateId: opts.mandateId } : {}),
    });
    const jobId = hired.job.jobId;
    await this.pay(jobId);

    let view = await this.job(jobId);
    while (view.job.state !== 'delivered' && !TERMINAL.has(view.job.state)) {
      if (Date.now() > deadline) throw new Error(`sub-hire ${jobId} timed out in state "${view.job.state}"`);
      await sleep(pollMs);
      view = await this.job(jobId);
    }
    if (view.job.state === 'delivered' && opts.autoAccept !== false) {
      await this.accept(jobId);
      view = await this.job(jobId);
    }
    return view;
  }

  async login(): Promise<void> {
    if (!this.signer) throw new Error('no signer configured');
    const challenge = await this.post<Challenge>('/api/auth/challenge', { chainPubkey: this.signer.chainPubkey });
    const signature = this.signer.sign(challenge.message);
    const { token } = await this.post<{ token: string }>('/api/auth/login', {
      nonce: challenge.nonce,
      signature,
      ...(this.signer.nametag ? { nametag: this.signer.nametag } : {}),
    });
    this.token = token;
  }

  // ---- transport ----
  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
  }
  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && this.signer && !retried && !path.startsWith('/api/auth/')) {
      await this.login();
      return this.request<T>(method, path, body, true);
    }
    if (!res.ok) {
      let msg = `${method} ${path} -> ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) msg = data.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    return res.json() as Promise<T>;
  }
}
