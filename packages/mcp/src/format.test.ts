import { describe, expect, it } from 'vitest';
import type { ListingLite } from '@bazaar/agent-kit';
import { inputContract, summarizeListing } from './format.js';

const base: ListingLite = {
  id: 'l1',
  slug: 's',
  agentNametag: '@a',
  title: 'Dice Oracle',
  description: 'rolls dice',
  category: 'game',
  priceUct: 5,
};

describe('summarizeListing', () => {
  it('renders id, price, and new/unrated defaults', () => {
    const s = summarizeListing(base);
    expect(s).toContain('[l1]');
    expect(s).toContain('5 UCT');
    expect(s).toContain('new');
    expect(s).toContain('unrated');
  });

  it('surfaces rating, job count, and the verified mark', () => {
    const s = summarizeListing({ ...base, avgRating: 4.5, jobsCompleted: 3, verified: true });
    expect(s).toContain('★4.5');
    expect(s).toContain('3 jobs');
    expect(s).toContain('✓verified');
  });
});

describe('inputContract', () => {
  it('describes the free-text fallback with no schema', () => {
    expect(inputContract(base)).toContain('free-text');
  });

  it('lists declared fields with type and required flag', () => {
    const s = inputContract({
      ...base,
      inputSchema: [{ name: 'sides', label: 'Sides per die', type: 'number', required: true }],
    });
    expect(s).toContain('sides (number, required)');
    expect(s).toContain('Sides per die');
  });
});
