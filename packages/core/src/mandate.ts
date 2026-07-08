/**
 * Spending mandates - a buyer's signed authorization for an agent to hire on
 * their behalf, up to a budget (inspired by Google's AP2 signed mandates).
 *
 * The buyer signs a canonical mandate statement with their wallet key. It names
 * the agent (by chain pubkey) allowed to spend, a total and per-job UCT cap, an
 * optional category allow-list, and an expiry. The platform verifies the
 * signature (secp256k1, via the SDK's `verifySignedMessage`) and then enforces
 * the caps as the agent hires.
 *
 * Important - this is authorization, NOT custody: the platform never moves the
 * buyer's funds. The agent still funds each escrow from its own wallet; the
 * mandate is the buyer's cryptographic delegation plus a platform-enforced
 * budget guardrail, and it is independently verifiable by anyone.
 *
 * This module is dependency-free: it defines the mandate shape and the exact
 * bytes that get signed. Signing/verifying lives wherever the SDK is available.
 */

/** The canonical, signed authorization. */
export interface SpendingMandate {
  v: 1;
  /** Random unique id (also the signing nonce, so each mandate signs uniquely). */
  mandateId: string;
  /** Buyer principal that signed this - their compressed chain pubkey. */
  buyer: string;
  /** The agent authorized to spend - its compressed chain pubkey. */
  agent: string;
  /** Total UCT the agent may spend across all hires under this mandate. */
  maxTotalUct: number;
  /** Maximum UCT for any single hire under this mandate. */
  maxPerJobUct: number;
  /** Allowed listing categories, or `['*']` for any. */
  categories: string[];
  /** Epoch ms after which the mandate is void. */
  expiresAt: number;
  createdAt: number;
}

/** A mandate plus the buyer's signature over its canonical form. */
export interface SignedMandate {
  mandate: SpendingMandate;
  /** 130-hex secp256k1 signature over `canonicalMandate(mandate)`. */
  signature: string;
  /** The buyer's compressed chain pubkey that produced the signature. */
  signer: string;
}

/** Live view of how much of a mandate's budget remains. */
export interface MandateStatus {
  mandateId: string;
  buyer: string;
  agent: string;
  maxTotalUct: number;
  maxPerJobUct: number;
  categories: string[];
  spentUct: number;
  remainingUct: number;
  jobs: number;
  expiresAt: number;
  expired: boolean;
  active: boolean;
}

/**
 * The exact string that gets signed and verified. Field order is fixed (not left
 * to `JSON.stringify` key order) so the signed bytes are stable across platforms
 * and versions. Categories are sorted so ordering can't change the signature.
 * Never reorder without bumping `v`.
 */
export function canonicalMandate(m: SpendingMandate): string {
  return JSON.stringify([
    'bazaar-mandate',
    m.v,
    m.mandateId,
    m.buyer,
    m.agent,
    m.maxTotalUct,
    m.maxPerJobUct,
    [...m.categories].sort().join(','),
    m.expiresAt,
    m.createdAt,
  ]);
}

export type MandateCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Pure policy check: may `agent` spend `amountUct` on a `category` hire under
 * this mandate, given how much has already been spent? Does not verify the
 * signature (do that once at registration) - this is the per-hire gate.
 */
export function checkMandate(
  m: SpendingMandate,
  spentUct: number,
  agent: string,
  amountUct: number,
  category: string,
  now = Date.now(),
): MandateCheck {
  if (now >= m.expiresAt) return { ok: false, reason: 'mandate expired' };
  if (agent.toLowerCase() !== m.agent.toLowerCase()) {
    return { ok: false, reason: 'agent not authorized by this mandate' };
  }
  if (amountUct > m.maxPerJobUct) {
    return { ok: false, reason: `exceeds per-job cap (${m.maxPerJobUct} UCT)` };
  }
  if (spentUct + amountUct > m.maxTotalUct) {
    return { ok: false, reason: `exceeds remaining budget (${m.maxTotalUct - spentUct} UCT left)` };
  }
  if (!m.categories.includes('*') && !m.categories.includes(category)) {
    return { ok: false, reason: `category "${category}" not permitted by this mandate` };
  }
  return { ok: true };
}
