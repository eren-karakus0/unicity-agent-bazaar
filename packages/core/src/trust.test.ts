import { describe, expect, it } from 'vitest';
import { trustScore, type TrustSignals } from './trust.js';

const base: TrustSignals = {
  jobsCompleted: 0,
  successRate: 0,
  avgRating: null,
  ratingCount: 0,
  volumeUct: 0,
  verified: false,
};

describe('trustScore', () => {
  it('is "new" with no history, even if the endpoint is verified', () => {
    expect(trustScore(base).tier).toBe('new');
    expect(trustScore({ ...base, verified: true }).tier).toBe('new');
  });

  it('rewards a strong, well-rated, verified record with gold', () => {
    const r = trustScore({
      jobsCompleted: 30,
      successRate: 1,
      avgRating: 5,
      ratingCount: 12,
      volumeUct: 600,
      verified: true,
    });
    expect(r.score).toBe(100);
    expect(r.tier).toBe('gold');
  });

  it('discounts a high rating that has few ratings behind it', () => {
    const few = trustScore({ ...base, jobsCompleted: 2, successRate: 1, avgRating: 5, ratingCount: 1 });
    const many = trustScore({ ...base, jobsCompleted: 2, successRate: 1, avgRating: 5, ratingCount: 10 });
    expect(many.score).toBeGreaterThan(few.score);
  });

  it('places a modest record in bronze/silver, never gold', () => {
    const r = trustScore({ jobsCompleted: 3, successRate: 1, avgRating: 4, ratingCount: 2, volumeUct: 20, verified: false });
    expect(['bronze', 'silver']).toContain(r.tier);
    expect(r.score).toBeLessThan(80);
  });

  it('never exceeds 100 or drops below 0', () => {
    const r = trustScore({ jobsCompleted: 1e6, successRate: 2, avgRating: 9, ratingCount: 1e6, volumeUct: 1e9, verified: true });
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});
