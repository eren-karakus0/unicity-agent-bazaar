import type { InputField, SignedReceipt } from '@bazaar/core';

/** A listing as the marketplace API returns it (decorated with platform metadata). */
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

/** Signs a challenge message with the agent wallet — injected so the client stays wallet-agnostic. */
export type Signer = {
  chainPubkey: string;
  nametag?: string;
  sign: (message: string) => string;
};

/** Thin typed client for the @bazaar/backend HTTP API, with wallet-session auth. */
export class BazaarClient {
  private token: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly signer?: Signer,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  get authenticated(): boolean {
    return this.token !== null;
  }

  // ---- public reads ----
  async listings(): Promise<ListingLite[]> {
    return (await this.get<{ listings: ListingLite[] }>('/api/listings')).listings;
  }
  async listing(id: string): Promise<ListingLite> {
    return (await this.get<{ listing: ListingLite }>(`/api/listings/${encodeURIComponent(id)}`)).listing;
  }
  async trending(n = 6): Promise<ListingLite[]> {
    return (await this.get<{ listings: ListingLite[] }>(`/api/listings/trending?n=${n}`)).listings;
  }
  async depositInfo(): Promise<DepositInfo> {
    return this.get<DepositInfo>('/api/deposit-info');
  }
  async job(jobId: string): Promise<JobView> {
    return this.get<JobView>(`/api/jobs/${encodeURIComponent(jobId)}`);
  }

  // ---- authenticated actions ----
  async hire(listingId: string, input: unknown): Promise<HireResult> {
    return this.post<HireResult>('/api/hire', { listingId, input });
  }
  async accept(jobId: string): Promise<{ job: JobView['job'] }> {
    return this.post<{ job: JobView['job'] }>(`/api/jobs/${encodeURIComponent(jobId)}/accept`, {});
  }
  async dispute(jobId: string): Promise<{ job: JobView['job'] }> {
    return this.post<{ job: JobView['job'] }>(`/api/jobs/${encodeURIComponent(jobId)}/dispute`, {});
  }

  /** Prove wallet ownership and obtain a session token. Requires a signer. */
  async login(): Promise<void> {
    if (!this.signer) throw new Error('no wallet configured — set BAZAAR_MCP_MNEMONIC to act');
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
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /** One request, transparently re-authenticating once on a 401. */
  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && this.signer && !retried && path !== '/api/auth/login' && path !== '/api/auth/challenge') {
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
