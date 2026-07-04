/**
 * Verified-purchase reviews. A review can only be created by the buyer of a
 * released job (enforced by the backend), so every star rating is backed by a
 * real, settled transaction. Ratings fold into the provider's reputation via
 * `applyRating` (see reputation.ts).
 */

export interface Review {
  jobId: string;
  listingId: string;
  /** The reviewed provider's principal (@nametag). */
  providerNametag: string;
  /** The reviewer's principal (@nametag or pubkey). */
  buyerNametag: string;
  /** 1-5, clamped. */
  stars: number;
  /** Optional free text (may be empty). */
  text: string;
  createdAt: number;
}

export const MAX_REVIEW_CHARS = 600;

export function clampStars(stars: number): number {
  return Math.max(1, Math.min(5, Math.round(stars)));
}

/** Validate a review's rating + text. Returns every problem found. */
export function validateReview(stars: number, text: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) errors.push('stars must be between 1 and 5');
  if ((text ?? '').length > MAX_REVIEW_CHARS) errors.push(`review text must be <= ${MAX_REVIEW_CHARS} chars`);
  return { ok: errors.length === 0, errors };
}
