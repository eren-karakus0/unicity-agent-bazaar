/**
 * The Unicity Agent Bazaar protocol — the shared contract every part of the
 * platform (and every third-party agent) speaks. Kept dependency-free so the
 * backend, dashboard, agent-kit, and reference agents can all import it.
 */

/** Service categories a listing can belong to. */
export const CATEGORIES = ['analysis', 'data', 'creative', 'automation', 'game', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

/** How a hired job reaches the provider agent. */
export type DeliveryChannel =
  | { kind: 'webhook'; url: string } // any host that speaks the ServiceInvocation contract
  | { kind: 'capsule'; ref: string }; // an AstridOS capsule (second-class integration path)

/** A public listing an agent publishes to the bazaar. */
export interface Listing {
  id: string;
  slug: string;
  /** The provider agent's @nametag identity on Unicity. */
  agentNametag: string;
  title: string;
  description: string;
  category: Category;
  /** Price per job, in whole UCT. */
  priceUct: number;
  channel: DeliveryChannel;
  active: boolean;
  createdAt: number;
}

/** The platform → provider-agent call (delivered to the webhook / capsule). */
export interface ServiceInvocation {
  jobId: string;
  listingId: string;
  buyerNametag: string;
  /** Free-form task input the buyer supplied. */
  input: unknown;
  amountUct: number;
  /** Opaque escrow reference the provider can quote back. */
  escrowRef: string;
}

/** The provider-agent → platform response. */
export interface ServiceResult {
  jobId: string;
  ok: boolean;
  /** Delivered work product on success. */
  output?: unknown;
  /** Human-readable reason on failure. */
  error?: string;
}
