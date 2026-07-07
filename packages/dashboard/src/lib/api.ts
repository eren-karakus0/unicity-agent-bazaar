/** Typed client for the @bazaar/backend HTTP API. Mirrors the protocol shapes. */

const BASE = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4600').replace(/\/$/, '');

export type Category = 'analysis' | 'data' | 'creative' | 'automation' | 'game' | 'other';
export const CATEGORIES: Category[] = ['analysis', 'data', 'creative', 'automation', 'game', 'other'];

export type DeliveryChannel = { kind: 'webhook'; url: string } | { kind: 'capsule'; ref: string };

export interface Listing {
  id: string;
  slug: string;
  agentNametag: string;
  title: string;
  description: string;
  category: Category;
  priceUct: number;
  channel: DeliveryChannel;
  active: boolean;
  createdAt: number;
  // platform metadata (present on decorated responses)
  favorites?: number;
  hot?: number;
  avgRating?: number | null;
  ratingCount?: number;
  jobsCompleted?: number;
  successRate?: number;
  health?: ListingHealth | null;
  verified?: boolean;
}

export interface ListingHealth {
  ok: boolean;
  checkedAt: number;
  detail?: string;
}

export interface Review {
  jobId: string;
  listingId: string;
  providerNametag: string;
  buyerNametag: string;
  stars: number;
  text: string;
  createdAt: number;
}

export interface Achievement {
  id: string;
  label: string;
  description: string;
  side: 'provider' | 'buyer';
}

export type EscrowState =
  | 'quoted'
  | 'funded'
  | 'delivered'
  | 'released'
  | 'refunded'
  | 'disputed'
  | 'cancelled';

export interface EscrowJob {
  jobId: string;
  escrowRef: string;
  listingId: string;
  buyerNametag: string;
  providerNametag: string;
  amountUct: number;
  state: EscrowState;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
}

export interface ServiceResult {
  jobId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface Settlement {
  status: 'pending' | 'settled' | 'failed';
  kind: 'release' | 'refund';
  amountUct: number;
  recipient: string;
  txId?: string;
  error?: string;
  at: number;
}

export interface HireResult {
  job: EscrowJob;
  payTo: string;
  memo: string;
  amountUct: number;
  coinId: string;
  decimals: number;
}

export interface JobView {
  job: EscrowJob;
  result?: ServiceResult;
  settlement?: Settlement;
  review?: Review;
}

export interface ReputationView {
  agentNametag: string;
  jobsCompleted: number;
  successRate: number;
  volumeUct: number;
  avgRating: number | null;
}

export interface JobSummary {
  jobId: string;
  listingId: string;
  listingTitle?: string;
  amountUct: number;
  state: EscrowState;
  role: 'buyer' | 'provider';
  counterparty: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileView {
  principal: string;
  nametag?: string;
  chainPubkey?: string;
  reputation: ReputationView;
  listings: Listing[];
  asProvider: JobSummary[];
  asBuyer: JobSummary[];
  reviews: Review[];
  achievements: Achievement[];
  stats: {
    listingsActive: number;
    jobsAsProvider: number;
    jobsAsBuyer: number;
    earnedUct: number;
    spentUct: number;
    favoritesReceived: number;
  };
}

export interface DepositInfo {
  escrow: string;
  coinId: string;
  decimals: number;
  symbol: string;
}

export interface Identity {
  chainPubkey: string;
  nametag?: string;
}

export interface Challenge {
  nonce: string;
  message: string;
  expiresAt: number;
}

// ---- auth token (attached to every request once signed in) ----
let authToken: string | null = null;
export function setAuthToken(token: string | null): void {
  authToken = token;
}
function authHeaders(): Record<string, string> {
  return authToken ? { authorization: `Bearer ${authToken}` } : {};
}

/** An HTTP error carrying the status code (network failures throw a plain Error). */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { ...authHeaders() } });
  if (!res.ok) throw new HttpError((await safeErr(res)) ?? `GET ${path} → ${res.status}`, res.status);
  return res.json() as Promise<T>;
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError((await safeErr(res)) ?? `POST ${path} → ${res.status}`, res.status);
  return res.json() as Promise<T>;
}
async function safeErr(res: Response): Promise<string | undefined> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error;
  } catch {
    return undefined;
  }
}

export const api = {
  health: () => get<{ ok: boolean; ready: boolean; escrow: string | null }>('/api/health'),
  depositInfo: () => get<DepositInfo>('/api/deposit-info'),
  stats: () =>
    get<{ stats: { providers: number; listings: number; jobsSettled: number; uctSettled: number; reviews: number } }>(
      '/api/stats',
    ).then((r) => r.stats),
  listings: () => get<{ listings: Listing[] }>('/api/listings').then((r) => r.listings),
  listing: (id: string) => get<{ listing: Listing }>(`/api/listings/${encodeURIComponent(id)}`).then((r) => r.listing),

  // ---- auth ----
  challenge: (chainPubkey: string) => post<Challenge>('/api/auth/challenge', { chainPubkey }),
  login: (input: { nonce: string; signature: string; nametag?: string }) =>
    post<{ token: string; identity: Identity }>('/api/auth/login', input),
  me: () => get<{ identity: Identity }>('/api/auth/me').then((r) => r.identity),

  // ---- authenticated actions (server derives owner/buyer from the token) ----
  publish: (input: {
    title: string;
    description: string;
    category: Category;
    priceUct: number;
    webhookUrl: string;
  }) =>
    post<{ listing: Listing; webhookSecret?: string; health?: ListingHealth }>('/api/listings', {
      ...input,
      channelKind: 'webhook',
    }),
  testInvoke: (listingId: string, input: unknown) =>
    post<{ result: ServiceResult }>(`/api/listings/${encodeURIComponent(listingId)}/test`, { input }).then(
      (r) => r.result,
    ),
  recheckHealth: (listingId: string) =>
    post<{ health: ListingHealth }>(`/api/listings/${encodeURIComponent(listingId)}/health`, {}).then(
      (r) => r.health,
    ),
  hire: (listingId: string, input: unknown) => post<HireResult>('/api/hire', { listingId, input }),
  job: (jobId: string) => get<JobView>(`/api/jobs/${encodeURIComponent(jobId)}`),
  accept: (jobId: string) => post<{ job: EscrowJob }>(`/api/jobs/${encodeURIComponent(jobId)}/accept`, {}),
  dispute: (jobId: string) => post<{ job: EscrowJob }>(`/api/jobs/${encodeURIComponent(jobId)}/dispute`, {}),
  reputation: (nametag: string) =>
    get<{ reputation: ReputationView }>(`/api/reputation/${encodeURIComponent(nametag.replace(/^@/, ''))}`).then(
      (r) => r.reputation,
    ),
  profile: (principal: string) =>
    get<{ profile: ProfileView }>(`/api/profile/${encodeURIComponent(principal)}`).then((r) => r.profile),
  myProfile: () => get<{ profile: ProfileView }>('/api/profile/me').then((r) => r.profile),

  // ---- social ----
  trending: (n = 6) =>
    get<{ listings: Listing[] }>(`/api/listings/trending?n=${n}`).then((r) => r.listings),
  myFavorites: () => get<{ listings: Listing[]; ids: string[] }>('/api/favorites'),
  toggleFavorite: (listingId: string) =>
    post<{ favorited: boolean; favorites: number }>(
      `/api/listings/${encodeURIComponent(listingId)}/favorite`,
      {},
    ),
  review: (jobId: string, stars: number, text: string) =>
    post<{ review: Review }>(`/api/jobs/${encodeURIComponent(jobId)}/review`, { stars, text }).then(
      (r) => r.review,
    ),
  reviews: (principal: string) =>
    get<{ reviews: Review[] }>(`/api/reviews/${encodeURIComponent(principal)}`).then((r) => r.reviews),
};
