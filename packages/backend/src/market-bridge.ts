import type { MarketModule, PostIntentRequest, SearchIntentResult } from '@unicitylabs/sphere-sdk';
import type { Listing } from '@bazaar/core';
import { createLogger, type Logger } from './logger.js';

/** A market feed row. The SDK's `FeedListing` is not publicly exported, so we
 *  describe the subset of fields we consume (structurally compatible). */
export interface FeedRow {
  id: string;
  title: string;
  descriptionPreview: string;
  agentName: string;
  createdAt: string;
}

/**
 * A listing/intent surfaced from Unicity's decentralized market feed. Shared
 * shape whether it came from our own bazaar (posted outbound) or from another
 * agent anywhere on the network (pulled inbound).
 */
export interface DiscoverItem {
  id: string;
  title: string;
  description: string;
  agent?: string;
  category?: string;
  priceUct?: number;
  currency?: string;
  contactHandle?: string;
  /** epoch ms */
  createdAt: number;
  source: 'unicity';
}

/** A live "acquire UCT" rate aggregated from maker sell-offers on the feed. */
export interface UctRate {
  /** Quote currency you'd pay in (e.g. USDC, USDU). */
  currency: string;
  /** Best (lowest) quote-currency price for 1 UCT across current offers. */
  pricePerUct: number;
  /** How many live offers back this currency. */
  offers: number;
}

/** The subset of a market intent the rate aggregator reads. */
export interface RateIntent {
  intentType: string;
  price?: number;
  currency?: string;
}

export interface MarketBridgeOptions {
  /** Lazy accessor so the bridge tolerates the module appearing/disappearing. */
  market: () => MarketModule | null;
  /** Public bazaar base URL, woven into posted intents so others can hire back. */
  baseUrl?: string;
  expiresInDays?: number;
  logger?: Logger;
}

const MAX_DESC = 480;

/**
 * MarketBridge - connects our marketplace to Unicity's decentralized market feed
 * (the SDK Market module, backed by a market API + Nostr relays).
 *
 * Outbound: each published listing is broadcast as a `service` intent, so bazaar
 * agents are discoverable across the whole network. Inbound: `feed()`/`search()`
 * pull external intents into our own discovery.
 *
 * Every network call is best-effort: if the module is disabled or a relay is
 * unreachable, methods degrade to no-ops / empty results and NEVER throw, so
 * publishing and hiring are never blocked by the feed.
 */
export class MarketBridge {
  private readonly getMarket: () => MarketModule | null;
  private readonly baseUrl?: string;
  private readonly expiresInDays: number;
  private readonly log: Logger;
  /** listingId -> intentId, so we can close an intent when a listing dies. */
  private readonly posted = new Map<string, string>();

  constructor(opts: MarketBridgeOptions) {
    this.getMarket = opts.market;
    this.baseUrl = opts.baseUrl;
    this.expiresInDays = opts.expiresInDays ?? 30;
    this.log = opts.logger ?? createLogger('market');
  }

  /** True when the Market module is enabled and available. */
  get available(): boolean {
    return this.getMarket() != null;
  }

  /** Pure: map one of our listings to a Unicity `service` intent request. */
  static intentFor(
    listing: Pick<Listing, 'title' | 'description' | 'category' | 'priceUct' | 'agentNametag'>,
    opts: { baseUrl?: string; hireUrl?: string; expiresInDays?: number } = {},
  ): PostIntentRequest {
    const hire = opts.hireUrl ?? (opts.baseUrl ? `${opts.baseUrl.replace(/\/$/, '')}` : undefined);
    const desc = [
      listing.title.trim(),
      listing.description.trim(),
      hire ? `Hire on Unicity Agent Bazaar: ${hire}` : undefined,
    ]
      .filter(Boolean)
      .join('. ')
      .slice(0, MAX_DESC);
    return {
      description: desc,
      intentType: 'service',
      category: listing.category,
      price: listing.priceUct,
      currency: 'UCT',
      contactHandle: listing.agentNametag.replace(/^@/, ''),
      ...(opts.expiresInDays ? { expiresInDays: opts.expiresInDays } : {}),
    };
  }

  /** Broadcast a listing to the network feed. Returns the intent id, or null. */
  async publish(listing: Listing): Promise<string | null> {
    const m = this.getMarket();
    if (!m) return null;
    try {
      const req = MarketBridge.intentFor(listing, {
        baseUrl: this.baseUrl,
        expiresInDays: this.expiresInDays,
      });
      const res = await m.postIntent(req);
      this.posted.set(listing.id, res.intentId);
      this.log.info(`posted listing ${listing.slug} to Unicity feed (intent ${res.intentId.slice(0, 10)}…)`);
      return res.intentId;
    } catch (e) {
      this.log.warn(`could not post ${listing.slug} to feed: ${errMsg(e)}`);
      return null;
    }
  }

  /** Close the network intent for a listing that was deactivated. Best-effort. */
  async close(listingId: string): Promise<void> {
    const m = this.getMarket();
    const intentId = this.posted.get(listingId);
    if (!m || !intentId) return;
    try {
      await m.closeIntent(intentId);
      this.posted.delete(listingId);
    } catch (e) {
      this.log.warn(`could not close intent for ${listingId}: ${errMsg(e)}`);
    }
  }

  /** Recent intents from across the network. Empty on any failure. */
  async feed(limit = 24): Promise<DiscoverItem[]> {
    const m = this.getMarket();
    if (!m) return [];
    try {
      const rows = await m.getRecentListings();
      return rows.slice(0, limit).map(MarketBridge.fromFeed);
    } catch (e) {
      this.log.warn(`feed unavailable: ${errMsg(e)}`);
      return [];
    }
  }

  /** Search intents across the network. Empty on any failure. */
  async search(query: string, limit = 24): Promise<DiscoverItem[]> {
    const m = this.getMarket();
    const q = query.trim();
    if (!m || !q) return [];
    try {
      const res = await m.search(q, { limit });
      return res.intents.map(MarketBridge.fromIntent);
    } catch (e) {
      this.log.warn(`search unavailable: ${errMsg(e)}`);
      return [];
    }
  }

  /**
   * Live "acquire UCT" rates: makers on the network posting to SELL UCT are
   * exactly who a buyer short on UCT would buy from. We surface their offers as
   * peer rates (aggregated to the best price per currency) - honest discovery,
   * not an automated swap. Empty on any failure.
   */
  async rates(limit = 6): Promise<UctRate[]> {
    const m = this.getMarket();
    if (!m) return [];
    try {
      const res = await m.search('sell UCT', { limit: 40 });
      return MarketBridge.aggregateRates(res.intents).slice(0, limit);
    } catch (e) {
      this.log.warn(`rates unavailable: ${errMsg(e)}`);
      return [];
    }
  }

  /**
   * Pure: aggregate maker SELL intents into a best-price-per-currency table.
   * Only `sell` intents with a positive price and a currency count (those are
   * the offers a UCT buyer can take).
   */
  static aggregateRates(intents: RateIntent[]): UctRate[] {
    const best = new Map<string, { price: number; offers: number }>();
    for (const i of intents) {
      if (i.intentType !== 'sell') continue;
      if (typeof i.price !== 'number' || !(i.price > 0) || !i.currency) continue;
      const cur = i.currency.toUpperCase();
      const cur0 = best.get(cur);
      if (!cur0) best.set(cur, { price: i.price, offers: 1 });
      else best.set(cur, { price: Math.min(cur0.price, i.price), offers: cur0.offers + 1 });
    }
    return [...best.entries()]
      .map(([currency, v]) => ({ currency, pricePerUct: v.price, offers: v.offers }))
      .sort((a, b) => b.offers - a.offers || a.currency.localeCompare(b.currency));
  }

  /** Pure: a feed row -> DiscoverItem. */
  static fromFeed(f: FeedRow): DiscoverItem {
    return {
      id: f.id,
      title: f.title,
      description: f.descriptionPreview,
      agent: f.agentName,
      createdAt: toEpoch(f.createdAt),
      source: 'unicity',
    };
  }

  /** Pure: a search result -> DiscoverItem. */
  static fromIntent(i: SearchIntentResult): DiscoverItem {
    return {
      id: i.id,
      title: titleOf(i.description),
      description: i.description,
      agent: i.agentNametag ? i.agentNametag.replace(/^@/, '') : undefined,
      category: i.category,
      priceUct: typeof i.price === 'number' ? i.price : undefined,
      currency: i.currency,
      contactHandle: i.contactHandle,
      createdAt: toEpoch(i.createdAt),
      source: 'unicity',
    };
  }
}

/** Derive a short title from a description body (first sentence, capped). */
function titleOf(description: string): string {
  const first = description.split(/[.!?\n]/)[0]?.trim() ?? description.trim();
  return first.length > 64 ? `${first.slice(0, 61)}…` : first || 'Untitled intent';
}

function toEpoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
