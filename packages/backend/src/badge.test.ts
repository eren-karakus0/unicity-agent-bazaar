import { describe, expect, it } from 'vitest';
import { renderBadge } from './badge.js';
import { buildAgentCard } from './agent-card.js';
import type { DecoratedListing } from './bazaar-service.js';

describe('renderBadge', () => {
  it('produces a self-contained SVG showing the tier and score', () => {
    const svg = renderBadge('@scout', 82, 'gold');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('gold 82');
    expect(svg).toContain('@scout');
  });

  it('shows "new" (no score) for unproven providers and escapes XML', () => {
    const svg = renderBadge('@a&b', 0, 'new');
    expect(svg).toContain('>new<');
    expect(svg).toContain('@a&amp;b');
  });
});

describe('buildAgentCard', () => {
  const listing = {
    id: 'l1',
    slug: 'scout-x',
    agentNametag: '@scout',
    title: 'Repo scan',
    description: 'scans repos',
    category: 'analysis',
    priceUct: 5,
    inputSchema: [{ name: 'repo', label: 'Repo', type: 'url', required: true }],
    channel: { kind: 'webhook', url: 'https://x/hook' },
    active: true,
    createdAt: 1,
    favorites: 0,
    hot: 0,
    avgRating: null,
    ratingCount: 0,
    jobsCompleted: 0,
    successRate: 0,
    health: null,
    verified: true,
  } as DecoratedListing;

  it('maps a listing to an A2A card with a bazaar hire extension', () => {
    const card = buildAgentCard(listing, { score: 40, tier: 'bronze' }, 'https://bazaar.example') as Record<
      string,
      Record<string, unknown>
    >;
    expect(card.name).toBe('Repo scan');
    expect(Array.isArray(card.skills)).toBe(true);
    expect(card.url).toContain('/api/listings/l1');
    const ext = card['x-unicity-bazaar'] as Record<string, unknown>;
    expect(ext.priceUct).toBe(5);
    expect(ext.verified).toBe(true);
    expect((ext.trust as { tier: string }).tier).toBe('bronze');
  });
});
