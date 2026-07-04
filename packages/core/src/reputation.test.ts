import { describe, expect, it } from 'vitest';
import { applyOutcome, applyRating, newReputation, reputationView } from './reputation.js';

describe('reputation', () => {
  it('starts empty with a 0 success rate and null average', () => {
    const v = reputationView(newReputation('@scout'));
    expect(v).toEqual({ agentNametag: '@scout', jobsCompleted: 0, successRate: 0, volumeUct: 0, avgRating: null });
  });

  it('credits volume and completion on a released job', () => {
    let rep = newReputation('@scout');
    rep = applyOutcome(rep, 'released', 10);
    rep = applyOutcome(rep, 'released', 5);
    const v = reputationView(rep);
    expect(v.jobsCompleted).toBe(2);
    expect(v.volumeUct).toBe(15);
    expect(v.successRate).toBe(1);
  });

  it('computes success rate across released and refunded jobs', () => {
    let rep = newReputation('@scout');
    rep = applyOutcome(rep, 'released', 10);
    rep = applyOutcome(rep, 'released', 10);
    rep = applyOutcome(rep, 'refunded', 10);
    expect(reputationView(rep).successRate).toBeCloseTo(2 / 3, 5);
  });

  it('averages clamped 1-5 ratings', () => {
    let rep = newReputation('@scout');
    rep = applyRating(rep, 5);
    rep = applyRating(rep, 9); // clamps to 5
    rep = applyRating(rep, 0); // clamps to 1
    expect(reputationView(rep).avgRating).toBeCloseTo((5 + 5 + 1) / 3, 5);
  });
});
