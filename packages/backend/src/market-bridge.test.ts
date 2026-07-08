import { describe, expect, it } from 'vitest';
import { MarketBridge, type FeedRow } from './market-bridge.js';
import type { SearchIntentResult } from '@unicitylabs/sphere-sdk';

describe('MarketBridge.intentFor', () => {
  const listing = {
    title: 'Repo risk scan',
    description: 'Scores a public repo for supply-chain risk.',
    category: 'analysis' as const,
    priceUct: 10,
    agentNametag: '@scout',
  };

  it('maps a listing to a service intent priced in UCT', () => {
    const req = MarketBridge.intentFor(listing, { baseUrl: 'https://bazaar.example/', expiresInDays: 30 });
    expect(req.intentType).toBe('service');
    expect(req.currency).toBe('UCT');
    expect(req.price).toBe(10);
    expect(req.category).toBe('analysis');
    expect(req.contactHandle).toBe('scout'); // @ stripped
    expect(req.expiresInDays).toBe(30);
    expect(req.description).toContain('Repo risk scan');
    expect(req.description).toContain('bazaar.example');
  });

  it('caps the description length', () => {
    const long = { ...listing, description: 'x'.repeat(1000) };
    const req = MarketBridge.intentFor(long);
    expect(req.description.length).toBeLessThanOrEqual(480);
  });
});

describe('MarketBridge.fromFeed / fromIntent', () => {
  it('maps a feed row to a DiscoverItem', () => {
    const f: FeedRow = {
      id: 'i1',
      title: 'Translate EN->TR',
      descriptionPreview: 'Fast machine translation',
      agentName: 'lingo',
      createdAt: '2026-01-02T03:04:05Z',
    };
    const d = MarketBridge.fromFeed(f);
    expect(d).toMatchObject({ id: 'i1', title: 'Translate EN->TR', agent: 'lingo', source: 'unicity' });
    expect(d.createdAt).toBe(Date.parse('2026-01-02T03:04:05Z'));
  });

  it('derives a title from a search intent description and strips @', () => {
    const i: SearchIntentResult = {
      id: 'i2',
      score: 0.9,
      agentNametag: '@oracle',
      agentPublicKey: '02aa',
      description: 'Weather oracle. Returns a 7-day forecast for any city.',
      intentType: 'service',
      category: 'data',
      price: 3,
      currency: 'UCT',
      contactMethod: 'nostr',
      contactHandle: 'oracle',
      createdAt: '2026-02-02T00:00:00Z',
      expiresAt: '2026-03-02T00:00:00Z',
    };
    const d = MarketBridge.fromIntent(i);
    expect(d.title).toBe('Weather oracle');
    expect(d.agent).toBe('oracle');
    expect(d.priceUct).toBe(3);
    expect(d.currency).toBe('UCT');
    expect(d.source).toBe('unicity');
  });

  it('aggregates sell-UCT offers to the best price per currency', () => {
    const intents = [
      { intentType: 'sell', price: 1.05, currency: 'USDC' },
      { intentType: 'sell', price: 0.99, currency: 'usdc' }, // cheaper, case-normalized
      { intentType: 'sell', price: 3, currency: 'USDU' },
      { intentType: 'buy', price: 0.5, currency: 'USDC' }, // ignored (buy)
      { intentType: 'sell', price: 0, currency: 'USDC' }, // ignored (non-positive)
      { intentType: 'sell', price: 2, currency: undefined }, // ignored (no currency)
    ];
    const rates = MarketBridge.aggregateRates(intents);
    const usdc = rates.find((r) => r.currency === 'USDC')!;
    expect(usdc.pricePerUct).toBe(0.99);
    expect(usdc.offers).toBe(2);
    expect(rates.find((r) => r.currency === 'USDU')!.pricePerUct).toBe(3);
    // USDC (2 offers) ranks before USDU (1 offer)
    expect(rates[0]!.currency).toBe('USDC');
  });

  it('falls back to now for an unparseable date', () => {
    const f: FeedRow = {
      id: 'i3',
      title: 't',
      descriptionPreview: 'd',
      agentName: 'a',
      createdAt: 'not-a-date',
    };
    const before = Date.now();
    const d = MarketBridge.fromFeed(f);
    expect(d.createdAt).toBeGreaterThanOrEqual(before);
  });
});
