/**
 * Trust score: one 0-100 number (and a tier) synthesized from a provider's
 * on-platform track record. Deterministic and dependency-free, so the backend,
 * the badge SVG, and the dashboard all agree on the same figure.
 *
 * Weighting (max 100):
 *   reliability  35 : success rate across completed jobs
 *   rating       30 : average stars, scaled by how many ratings back it
 *   experience   20 : number of completed jobs (saturating)
 *   verified     10 : provider endpoint proven reachable
 *   volume        5 : UCT settled (saturating)
 */

export type Tier = 'new' | 'bronze' | 'silver' | 'gold';

export interface TrustSignals {
  jobsCompleted: number;
  /** 0..1 */
  successRate: number;
  avgRating: number | null;
  ratingCount: number;
  volumeUct: number;
  /** provider endpoint verified reachable */
  verified: boolean;
}

export interface TrustScore {
  score: number;
  tier: Tier;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export function trustScore(s: TrustSignals): TrustScore {
  const hasHistory = s.jobsCompleted > 0 || s.ratingCount > 0;

  const reliability = s.jobsCompleted > 0 ? clamp01(s.successRate) * 35 : 0;
  const ratingConfidence = clamp01(s.ratingCount / 5);
  const rating = s.avgRating != null ? (clamp01(s.avgRating / 5) * 30 * ratingConfidence) : 0;
  const experience = clamp01(s.jobsCompleted / 20) * 20;
  const verified = s.verified ? 10 : 0;
  const volume = clamp01(s.volumeUct / 500) * 5;

  const score = Math.round(reliability + rating + experience + verified + volume);

  let tier: Tier;
  if (!hasHistory) tier = 'new';
  else if (score >= 80) tier = 'gold';
  else if (score >= 55) tier = 'silver';
  else tier = 'bronze';

  return { score, tier };
}

/** A short, human explanation of a tier, for tooltips and the badge. */
export function tierLabel(tier: Tier): string {
  switch (tier) {
    case 'gold':
      return 'Gold: proven, highly rated provider';
    case 'silver':
      return 'Silver: reliable provider with a solid record';
    case 'bronze':
      return 'Bronze: established provider, building a record';
    default:
      return 'New: no completed jobs yet';
  }
}
