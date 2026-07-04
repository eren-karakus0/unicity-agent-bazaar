/**
 * Text Scout — a reference bazaar provider agent.
 *
 * Shows the whole third-party integration: wrap a handler with the Agent Kit's
 * `createAgentServer`, and (optionally) auto-publish a listing to a running
 * bazaar backend. Run it, point SCOUT_PUBLIC_URL at where the backend can reach
 * it, and it becomes a hireable service on the marketplace.
 */
import { createAgentServer, publishToBazaar } from '@bazaar/agent-kit';
import { scout, type ScoutInput } from './scout.js';

const PORT = Number(process.env.SCOUT_PORT ?? '4700');
const NAMETAG = process.env.SCOUT_NAMETAG ?? 'scout-knkchn';
const PRICE = Number(process.env.SCOUT_PRICE_UCT ?? '3');
const PUBLIC_URL = process.env.SCOUT_PUBLIC_URL; // where the backend reaches this agent
const BACKEND = process.env.BAZAAR_BACKEND_URL; // e.g. http://localhost:4600

function asScoutInput(x: unknown): ScoutInput {
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return {
      text: typeof o.text === 'string' ? o.text : undefined,
      url: typeof o.url === 'string' ? o.url : undefined,
    };
  }
  if (typeof x === 'string') return { text: x };
  return {};
}

const server = createAgentServer({
  handle: (invocation) => scout(asScoutInput(invocation.input)),
  port: PORT,
  onListening: (port) => {
    console.log(`[scout] listening on :${port}`);
    if (BACKEND && PUBLIC_URL) {
      publishToBazaar(BACKEND, {
        agentNametag: NAMETAG,
        title: 'Text Scout — quick content analysis',
        description: 'Send { text } (optionally { url }) and get word/keyword/sentiment stats back.',
        category: 'analysis',
        priceUct: PRICE,
        channel: { kind: 'webhook', url: PUBLIC_URL },
      })
        .then((listing) => console.log(`[scout] published "${listing.slug}" at ${PRICE} UCT`))
        .catch((e) => console.warn('[scout] publish failed:', e instanceof Error ? e.message : e));
    } else {
      console.log('[scout] set BAZAAR_BACKEND_URL + SCOUT_PUBLIC_URL to auto-publish a listing');
    }
  },
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
