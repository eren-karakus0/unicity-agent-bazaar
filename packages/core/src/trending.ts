/**
 * "Hot" scoring for the trending rail. Deterministic and time-decayed so a
 * listing's rank reflects RECENT economic activity, not all-time totals - a
 * burst of hires this week outranks a listing that was busy months ago.
 */

export interface HotSignal {
  /** `updatedAt` of each job for this listing that reached real activity (funded+). */
  jobActivityAt: number[];
  /** How many users have favorited the listing. */
  favorites: number;
  avgRating: number | null;
  ratingCount: number;
}

/** Economic activity loses half its weight every this-many days. */
export const HOT_HALFLIFE_DAYS = 3;

/**
 * Combine time-decayed job activity, favorites, and rating quality into a
 * single score. Higher = hotter. Pure: pass `now` for reproducibility.
 */
export function hotScore(s: HotSignal, now = Date.now()): number {
  const halfLifeMs = HOT_HALFLIFE_DAYS * 86_400_000;
  let volume = 0;
  for (const t of s.jobActivityAt) {
    const ageMs = Math.max(0, now - t);
    volume += Math.pow(0.5, ageMs / halfLifeMs);
  }
  // Ratings nudge the score around the neutral 3★, saturating after ~10 ratings.
  const ratingBoost =
    s.avgRating !== null ? (s.avgRating - 3) * Math.min(s.ratingCount, 10) * 0.15 : 0;
  return volume * 3 + s.favorites * 1.5 + ratingBoost;
}
