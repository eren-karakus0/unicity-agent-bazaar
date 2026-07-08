/**
 * House agents - a couple of first-party reference agents the platform runs
 * itself, so the marketplace is never empty and the whole signed-webhook path
 * (publish → sign → verify → deliver → settle) is dogfooded on every boot.
 *
 * Each agent is a real `@bazaar/agent-kit` HTTP server on a loopback port,
 * published as a listing whose webhook URL points back at it and whose job
 * POSTs are HMAC-signed with a per-listing secret. Settlement routes to the
 * escrow wallet's own key, so released funds simply return to the house.
 */
import type http from 'node:http';
import crypto from 'node:crypto';
import { makeListing, type InputField, type ServiceInvocation } from '@bazaar/core';
import { createAgentServer, type AgentHandler } from '@bazaar/agent-kit';
import type { BazaarService } from './bazaar-service.js';
import type { Identity } from './auth.js';
import { createLogger, type Logger } from './logger.js';

const HOUSE_NAMETAG = 'bazaar-labs';

interface HouseAgent {
  /** Loopback port offset from the base - keeps URLs (and thus listing ids) stable. */
  portOffset: number;
  /** Fixed timestamp → deterministic listing id across restarts. */
  seedAt: number;
  title: string;
  description: string;
  category: string;
  priceUct: number;
  inputSchema: InputField[];
  handle: AgentHandler;
}

const asRecord = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
const clampInt = (v: unknown, def: number, min: number, max: number): number => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

/** Text Insights: word/sentence stats, reading time, and top keywords. Deterministic. */
const textInsights: AgentHandler = (inv: ServiceInvocation) => {
  const text = String(asRecord(inv.input).text ?? '').trim();
  if (!text) throw new Error('provide some text in the "text" field to analyze');
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim()).length || 1;
  const readingTimeSec = Math.max(1, Math.round((words.length / 200) * 60));
  const longestWord = words.reduce((a, w) => (w.length > a.length ? w : a), '');
  const freq = new Map<string, number>();
  for (const w of words) {
    const k = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (k.length >= 4) freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  const topKeywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));
  return {
    words: words.length,
    characters: text.length,
    sentences,
    readingTimeSec,
    longestWord,
    topKeywords,
  };
};

/** Dice Oracle: roll N dice with any number of sides. A tiny end-to-end demo. */
const diceOracle: AgentHandler = (inv: ServiceInvocation) => {
  const sides = clampInt(asRecord(inv.input).sides, 6, 2, 1000);
  const rolls = clampInt(asRecord(inv.input).rolls, 3, 1, 100);
  const results = Array.from({ length: rolls }, () => 1 + crypto.randomInt(sides));
  return { sides, rolls, results, total: results.reduce((a, b) => a + b, 0) };
};

const AGENTS: HouseAgent[] = [
  {
    portOffset: 1,
    seedAt: 1_700_000_000_001,
    title: 'Text Insights - instant content analysis',
    description:
      'Send any text and get word & sentence counts, an estimated reading time, the longest word, and the top keywords. A first-party agent, always live.',
    category: 'analysis',
    priceUct: 2,
    inputSchema: [
      { name: 'text', label: 'Text to analyze', type: 'textarea', required: true, placeholder: 'Paste text here…' },
    ],
    handle: textInsights,
  },
  {
    portOffset: 2,
    seedAt: 1_700_000_000_002,
    title: 'Dice Oracle - hire an agent in one click',
    description:
      'Roll any number of dice with any number of sides. The simplest possible agent - hire it end-to-end to see escrow, delivery, and release in action.',
    category: 'game',
    priceUct: 1,
    inputSchema: [
      { name: 'sides', label: 'Sides per die', type: 'number', placeholder: '6' },
      { name: 'rolls', label: 'Number of dice', type: 'number', placeholder: '3' },
    ],
    handle: diceOracle,
  },
];

export interface HouseAgentsHandle {
  servers: http.Server[];
  stop: () => Promise<void>;
}

/**
 * Start the house agents and seed their listings. Never throws - a failure to
 * bind a loopback port just means that demo agent is skipped this boot.
 */
export async function startHouseAgents(opts: {
  svc: BazaarService;
  escrowChainPubkey?: string;
  portBase: number;
  logger?: Logger;
}): Promise<HouseAgentsHandle> {
  const log = opts.logger ?? createLogger('house');
  const servers: http.Server[] = [];

  if (!opts.escrowChainPubkey) {
    log.warn('escrow chain pubkey unavailable - skipping house agents (no fund-safe settlement key)');
    return { servers, stop: async () => {} };
  }
  // Released funds route to this key - the escrow wallet itself, so they return home.
  const owner: Identity = { chainPubkey: opts.escrowChainPubkey, nametag: HOUSE_NAMETAG };

  for (const def of AGENTS) {
    const port = opts.portBase + def.portOffset;
    const secret = crypto.randomBytes(24).toString('hex');
    try {
      const server = await listen(def.handle, port, secret);
      servers.push(server);
      const url = `http://127.0.0.1:${port}/`;
      const listing = makeListing(
        {
          agentNametag: HOUSE_NAMETAG,
          title: def.title,
          description: def.description,
          category: def.category,
          priceUct: def.priceUct,
          channel: { kind: 'webhook', url },
          inputSchema: def.inputSchema,
        },
        def.seedAt,
      );
      opts.svc.seedListing(listing, owner, secret);
      await opts.svc.verifyListingHealth(listing.id);
      log.info(`house agent live: ${listing.slug} on :${port}`);
    } catch (e) {
      log.warn(`house agent "${def.title}" skipped: ${e instanceof Error ? e.message : e}`);
    }
  }

  return {
    servers,
    stop: () => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined),
  };
}

/** Bind an agent-kit server to a loopback port, resolving once it's listening. */
function listen(handle: AgentHandler, port: number, secret: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = createAgentServer({ handle, port, secret, onListening: () => resolve(server) });
    server.on('error', reject);
  });
}
