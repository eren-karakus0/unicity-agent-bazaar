import { describe, expect, it } from 'vitest';
import { validateReview, clampStars, MAX_REVIEW_CHARS } from './review.js';
import { hotScore } from './trending.js';
import { earnedAchievements, type AchievementSignals } from './achievements.js';

describe('reviews', () => {
  it('validates star range and text length', () => {
    expect(validateReview(5, 'great').ok).toBe(true);
    expect(validateReview(0, '').ok).toBe(false);
    expect(validateReview(6, '').ok).toBe(false);
    expect(validateReview(4, 'x'.repeat(MAX_REVIEW_CHARS + 1)).ok).toBe(false);
  });
  it('clamps stars into 1-5', () => {
    expect(clampStars(0)).toBe(1);
    expect(clampStars(9)).toBe(5);
    expect(clampStars(3.4)).toBe(3);
  });
});

describe('hotScore', () => {
  it('weights recent activity above old activity', () => {
    const now = 10 * 86_400_000;
    const recent = hotScore({ jobActivityAt: [now - 86_400_000], favorites: 0, avgRating: null, ratingCount: 0 }, now);
    const old = hotScore({ jobActivityAt: [now - 20 * 86_400_000], favorites: 0, avgRating: null, ratingCount: 0 }, now);
    expect(recent).toBeGreaterThan(old);
  });
  it('rewards favorites and good ratings', () => {
    const now = 1_000_000;
    const base = hotScore({ jobActivityAt: [], favorites: 0, avgRating: null, ratingCount: 0 }, now);
    const faved = hotScore({ jobActivityAt: [], favorites: 4, avgRating: null, ratingCount: 0 }, now);
    const rated = hotScore({ jobActivityAt: [], favorites: 0, avgRating: 5, ratingCount: 8 }, now);
    expect(faved).toBeGreaterThan(base);
    expect(rated).toBeGreaterThan(base);
  });
  it('penalizes bad ratings below neutral', () => {
    const now = 1_000_000;
    const bad = hotScore({ jobActivityAt: [], favorites: 0, avgRating: 1.5, ratingCount: 6 }, now);
    expect(bad).toBeLessThan(0);
  });
});

describe('achievements', () => {
  const empty: AchievementSignals = {
    listingsPublished: 0,
    jobsSoldReleased: 0,
    jobsSoldRefunded: 0,
    earnedUct: 0,
    avgRating: null,
    ratingCount: 0,
    jobsBoughtReleased: 0,
    spentUct: 0,
    distinctProvidersBought: 0,
  };

  it('awards nothing to a brand-new principal', () => {
    expect(earnedAchievements(empty)).toEqual([]);
  });

  it('awards provider milestones', () => {
    const ids = earnedAchievements({
      ...empty,
      listingsPublished: 1,
      jobsSoldReleased: 12,
      jobsSoldRefunded: 0,
      earnedUct: 120,
      avgRating: 4.8,
      ratingCount: 6,
    }).map((a) => a.id);
    expect(ids).toEqual(
      expect.arrayContaining(['listed', 'first-sale', 'rising', 'flawless', 'top-rated', 'big-earner']),
    );
    expect(ids).not.toContain('veteran'); // needs 25
  });

  it('awards buyer milestones', () => {
    const ids = earnedAchievements({
      ...empty,
      jobsBoughtReleased: 6,
      spentUct: 140,
      distinctProvidersBought: 4,
    }).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['first-hire', 'regular', 'patron', 'explorer']));
  });
});
