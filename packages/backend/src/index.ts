/**
 * Unicity Agent Bazaar - backend.
 *
 * Runs the platform's autonomous escrow agent on Unicity testnet2 and exposes
 * the marketplace to the web:
 *   GET  /api/listings                      -> browse active listings
 *   POST /api/listings   { agentNametag, .. }-> publish a listing
 *   POST /api/hire       { listingId, ... }  -> open escrow + payment instructions
 *   GET  /api/jobs/:id                        -> job status (+ result, settlement)
 *   POST /api/jobs/:id/accept                 -> release funds to the provider
 *   POST /api/jobs/:id/dispute                -> contest a delivered job
 *   GET  /api/reputation/:nametag             -> a provider's standing
 *   GET  /api/deposit-info                    -> where/how to fund an escrow
 *   GET  /api/health                          -> readiness probe
 */
import http from 'node:http';
import path from 'node:path';
import { verifySignedMessage } from '@unicitylabs/sphere-sdk';
import { canonicalReceipt, makeListing, type InputField, type SettlementReceipt } from '@bazaar/core';
import { CapsuleHub } from './capsule-hub.js';
import { loadEnv } from './config.js';
import { createLogger } from './logger.js';
import { SphereAgent } from './sphere-agent.js';
import { BazaarService, toPrincipal, type BazaarSnapshot } from './bazaar-service.js';
import { AuthService, principalOf, type Identity } from './auth.js';
import { createHealthProber, createWebhookInvoker } from './webhook-client.js';
import { startHouseAgents } from './house-agents.js';
import { renderBadge } from './badge.js';
import { buildAgentCard } from './agent-card.js';
import { MarketBridge } from './market-bridge.js';
import { AutonomousPatron } from './patron.js';
import { createSnapshotStore } from './store.js';

const env = loadEnv();
const log = createLogger('backend');

const auth = new AuthService({
  sessionSecret: env.auth.sessionSecret,
  sessionTtlMs: env.auth.sessionTtlMs,
  verify: verifySignedMessage,
  logger: createLogger('auth'),
});
if (env.auth.secretIsEphemeral) {
  log.warn('BAZAAR_SESSION_SECRET is unset - using a random per-boot secret; logins reset on restart.');
}

const escrowAgent = new SphereAgent({
  name: 'escrow',
  nametag: env.escrow.nametag,
  dataDir: path.join(env.dataRoot, 'escrow'),
  network: env.network,
  oracleApiKey: env.oracleApiKey,
  walletApiUrl: env.walletApiUrl,
  mnemonic: env.escrow.mnemonic,
  mnemonicEnvHint: 'BAZAAR_ESCROW_MNEMONIC',
  deviceId: 'bazaar-escrow',
  enableMarket: env.market,
  logger: createLogger('escrow'),
});

let service: BazaarService | null = null;
let market: MarketBridge | null = null;
let patron: AutonomousPatron | null = null;
// The capsule mailbox (kind:'capsule' listings). Enabled only when the shared
// secret env is set; the capsule provider polls it from inside its sandbox.
const capsuleHub = env.capsuleSecret
  ? new CapsuleHub({ secret: env.capsuleSecret, logger: createLogger('capsule-hub') })
  : null;
const CAPSULE_REF = 'arcade-player';
let ready = false;

const snapshotFile = path.join(env.dataRoot, 'bazaar-state.json');

async function boot(): Promise<void> {
  await escrowAgent.start();
  // First-party loopback agents register their origin here so the SSRF guard
  // permits them while still blocking user-supplied private/loopback URLs.
  const trustedHosts = new Set<string>();
  // Webhook listings get POSTed to; capsule listings park in the hub until
  // the sandboxed provider polls its inbox (capsules cannot receive pushes).
  const webhookInvoke = createWebhookInvoker({ timeoutMs: 20_000, allowHosts: trustedHosts });
  service = new BazaarService({
    agent: escrowAgent,
    invoke: (channel, invocation, secret) =>
      channel.kind === 'capsule' && capsuleHub
        ? capsuleHub.enqueue(channel.ref, invocation)
        : webhookInvoke(channel, invocation, secret),
    probe: createHealthProber({ timeoutMs: 5_000, allowHosts: trustedHosts }),
    ...(capsuleHub ? { capsuleHealth: (ref: string) => capsuleHub.health(ref) } : {}),
    autoReleaseMs: env.autoReleaseMs,
    verify: verifySignedMessage,
    logger: createLogger('bazaar'),
  });

  // Durable persistence: Postgres when DATABASE_URL is set, else a JSON file.
  const store = await createSnapshotStore<BazaarSnapshot>({
    databaseUrl: env.databaseUrl,
    file: snapshotFile,
    logger: createLogger('persist'),
  });
  log.info(`persistence backend: ${store.kind}`);
  const restored = await store.load();
  if (restored) {
    service.restore(restored);
    log.info(`restored marketplace state (${restored.listings?.length ?? 0} listings, ${restored.jobs?.length ?? 0} jobs)`);
  }
  const svcRef = service;
  // Only write when the snapshot actually changed. During idle periods this
  // means zero writes, so the Postgres (Neon) instance can auto-suspend instead
  // of being pinned awake by a fixed 10s write - keeps free-tier compute low.
  let lastSaved = '';
  setInterval(() => {
    void (async () => {
      const snap = svcRef.snapshot();
      const json = JSON.stringify(snap);
      if (json === lastSaved) return;
      if (await store.save(snap)) lastSaved = json;
    })();
  }, 10_000);

  // First-party "house" agents: keep the marketplace live + dogfood the signed
  // webhook path on every boot. Loopback-only, settled back to the escrow wallet.
  const house = await startHouseAgents({
    svc: service,
    escrowChainPubkey: escrowAgent.chainPubkey,
    portBase: env.port,
    logger: createLogger('house'),
    trustedHosts,
  });

  // The Unicity AOS capsule provider: the first REAL kind:'capsule' listing. Its
  // work runs INSIDE a Unicity AOS WASM sandbox on a separate machine - the
  // capsule polls /api/capsule/inbox, plays a provably-fair round at the live
  // Arcade House, verifies the reveal in-sandbox, and posts the result back.
  // Verified badge = inbox-poll liveness; offline capsule -> hire refunds.
  if (capsuleHub && escrowAgent.chainPubkey && env.capsuleSecret) {
    const capsuleListing = makeListing(
      {
        agentNametag: '@astrid-arcade',
        title: 'Arcade Oracle - a provably-fair game round from a Unicity AOS sandbox',
        description:
          'Hire an agent that lives inside a Unicity AOS WASM microkernel sandbox. It plays one ' +
          'provably-fair round at the live Unicity Arcade House with real testnet UCT, re-verifies ' +
          'the commit-reveal with its own in-sandbox SHA-256, and returns the full round report. ' +
          'Delivered over the capsule channel: the sandbox polls for work - nothing can push into it.',
        category: 'game',
        priceUct: 2,
        channel: { kind: 'capsule', ref: CAPSULE_REF },
        inputSchema: [
          { name: 'game', label: 'Game', type: 'text', placeholder: 'rps · wheel · plinko · dice · coin · highlow · number (random when empty)' },
          { name: 'bet', label: 'Bet (UCT chips)', type: 'number', placeholder: '1' },
        ],
      },
      1_700_000_000_004,
    );
    service.seedListing(
      capsuleListing,
      { chainPubkey: escrowAgent.chainPubkey, nametag: 'astrid-arcade' },
      env.capsuleSecret,
    );
    void service.verifyListingHealth(capsuleListing.id);
    log.info(`capsule listing live: ${capsuleListing.slug} (ref ${CAPSULE_REF})`);
  }

  const persistAndExit = () => {
    void (async () => {
      await store.save(svcRef.snapshot());
      await store.close();
      await house.stop().catch(() => undefined);
      await patron?.stop().catch(() => undefined);
      process.exit(0);
    })();
  };
  process.once('SIGTERM', persistAndExit);
  process.once('SIGINT', persistAndExit);

  // Escrow funding: buyers send UCT to the escrow wallet with the escrowRef as
  // the memo. Wallet-api rails deliver in the background and every delivery
  // lands in history as a RECEIVED entry; sweep it and match by memo.
  const FUNDING_WINDOW_MS = 60 * 60_000;
  const { coinId: uctCoinId } = escrowAgent.uctCoin;
  const sweepFunding = () => {
    try {
      const entries = escrowAgent.getHistory() as {
        id?: string;
        dedupKey?: string;
        type?: string;
        amount?: string;
        coinId?: string;
        symbol?: string;
        timestamp?: number;
        memo?: string;
      }[];
      const cutoff = Date.now() - FUNDING_WINDOW_MS;
      for (const e of entries) {
        if (e.type !== 'RECEIVED') continue;
        if (e.symbol !== 'UCT' && e.coinId !== uctCoinId) continue;
        if ((e.timestamp ?? 0) < cutoff) continue;
        const funded = service?.creditFunding({
          dedupKey: e.dedupKey ?? e.id ?? '',
          amountBase: e.amount ?? '0',
          memo: e.memo,
        });
        if (funded) log.info(`escrow funded: job ${funded.jobId}`);
      }
    } catch (e) {
      log.warn('funding sweep failed', e instanceof Error ? e.message : e);
    }
  };
  sweepFunding();
  setInterval(sweepFunding, 15_000);
  setInterval(() => service?.sweepAutoRelease(), 20_000);
  // Periodically re-probe provider endpoints; auto-deactivate ones that go dark.
  setInterval(() => void service?.sweepListingHealth(), 60_000);

  // Bridge to Unicity's decentralized market feed (best-effort; never blocks).
  if (env.market) {
    market = new MarketBridge({
      market: () => escrowAgent.market,
      baseUrl: env.publicUrl,
      logger: createLogger('market'),
    });
    if (market.available) {
      log.info('market feed available - broadcasting active listings');
      void (async () => {
        for (const listing of svcRef.getListings()) {
          await market?.publish(listing);
        }
      })();
    } else {
      log.info('market module not available on this wallet - feed disabled');
    }
  }

  ready = true;
  log.info(`bazaar online - escrow @${escrowAgent.nametag}`);

  // Autonomous patron (opt-in): a distinct wallet that continuously discovers,
  // hires and pays other agents - the machine economy, running with no human in
  // the loop. Started fire-and-forget so a slow wallet init never blocks boot,
  // and fully isolated so any failure leaves the marketplace untouched.
  if (env.patron) {
    patron = new AutonomousPatron({
      mnemonic: env.patron.mnemonic,
      nametag: env.patron.nametag,
      intervalMs: env.patron.intervalMs,
      baseUrl: `http://127.0.0.1:${env.port}`,
      dataDir: env.dataRoot,
      network: env.network,
      oracleApiKey: env.oracleApiKey,
      walletApiUrl: env.walletApiUrl,
      logger: createLogger('patron'),
    });
    patron.start().catch((e) => {
      log.warn('patron failed to start (marketplace unaffected):', e instanceof Error ? e.message : e);
      patron = null;
    });
  }
}

// ---- http helpers ----
function setCors(res: http.ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  // `authorization` is REQUIRED here: signed-in requests carry a Bearer token,
  // which triggers a CORS preflight - omitting it blocks every authed fetch.
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-max-age', '600');
}
function json(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve((JSON.parse(body || '{}') as Record<string, unknown>) ?? {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Reconstruct this deployment's public base URL from the request (for A2A cards). */
function baseUrlOf(req: http.IncomingMessage): string {
  const host = (req.headers['host'] as string) ?? 'localhost';
  const fwd = str(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim();
  const proto = fwd ?? (/^(localhost|127\.|\[::1\])/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Coerce a request body's `inputSchema` into declared fields (core validates them). */
function parseInputSchema(v: unknown): InputField[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: InputField[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = str(r.name);
    const label = str(r.label);
    const type = str(r.type);
    if (!name || !label || !type) continue;
    out.push({
      name,
      label,
      type: type as InputField['type'],
      ...(r.required === true ? { required: true } : {}),
      ...(str(r.placeholder) ? { placeholder: str(r.placeholder)! } : {}),
      ...(str(r.help) ? { help: str(r.help)! } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** The proven identity behind a request, from its `Authorization: Bearer <token>`. */
function identityOf(req: http.IncomingMessage): Identity | null {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  return auth.verifySession(header.slice('Bearer '.length).trim());
}

const server = http.createServer((req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  if (pathname === '/api/health') {
    json(res, 200, { ok: true, ready, escrow: ready ? `@${escrowAgent.nametag}` : null });
    return;
  }

  // ---- auth (available even while the bazaar is still waking up) ----
  if (pathname === '/api/auth/challenge' && method === 'POST') {
    void readJson(req).then((body) => {
      try {
        json(res, 200, auth.issueChallenge(str(body.chainPubkey) ?? ''));
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : 'could not issue challenge' });
      }
    });
    return;
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    void readJson(req).then((body) => {
      try {
        json(res, 200, auth.login({
          nonce: str(body.nonce) ?? '',
          signature: str(body.signature) ?? '',
          nametag: str(body.nametag),
        }));
      } catch (e) {
        json(res, 401, { error: e instanceof Error ? e.message : 'login failed' });
      }
    });
    return;
  }
  if (pathname === '/api/auth/me' && method === 'GET') {
    const identity = identityOf(req);
    if (!identity) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    json(res, 200, { identity });
    return;
  }

  // Verify a settlement receipt's signature against its claimed signer. Pure
  // crypto - anyone can call it (or verify offline with the Sphere SDK).
  if (pathname === '/api/receipt/verify' && method === 'POST') {
    void readJson(req).then((body) => {
      try {
        const receipt = body.receipt as SettlementReceipt | undefined;
        const signature = str(body.signature);
        const signer = str(body.signer);
        if (!receipt || !signature || !signer) {
          json(res, 400, { error: 'receipt, signature and signer are required' });
          return;
        }
        const valid = verifySignedMessage(canonicalReceipt(receipt), signature, signer);
        json(res, 200, { valid, signer });
      } catch (e) {
        json(res, 400, { valid: false, error: e instanceof Error ? e.message : 'verification failed' });
      }
    });
    return;
  }

  if (!service || !ready) {
    json(res, 503, { error: 'The bazaar is still waking up - try again in a few seconds.' });
    return;
  }
  const svc = service;

  if (pathname === '/api/deposit-info' && method === 'GET') {
    const { coinId, decimals } = escrowAgent.uctCoin;
    json(res, 200, { escrow: `@${escrowAgent.nametag}`, coinId, decimals, symbol: 'UCT' });
    return;
  }

  if (pathname === '/api/stats' && method === 'GET') {
    json(res, 200, { stats: svc.platformStats() });
    return;
  }

  // ---- the capsule provider's mailbox (kind:'capsule' listings) ----
  // The sandboxed capsule cannot receive pushes; it polls for leased work and
  // posts results back. Both calls carry the shared secret header.
  if (pathname === '/api/capsule/inbox' && method === 'GET') {
    if (!capsuleHub) {
      json(res, 503, { error: 'the capsule channel is not enabled on this server' });
      return;
    }
    const presented = req.headers['x-capsule-secret'];
    if (!capsuleHub.authorized(Array.isArray(presented) ? presented[0] : presented)) {
      json(res, 401, { error: 'bad capsule secret' });
      return;
    }
    const ref = url.searchParams.get('ref') ?? CAPSULE_REF;
    json(res, 200, { invocations: capsuleHub.lease(ref) });
    return;
  }
  if (pathname === '/api/capsule/result' && method === 'POST') {
    if (!capsuleHub) {
      json(res, 503, { error: 'the capsule channel is not enabled on this server' });
      return;
    }
    const presented = req.headers['x-capsule-secret'];
    if (!capsuleHub.authorized(Array.isArray(presented) ? presented[0] : presented)) {
      json(res, 401, { error: 'bad capsule secret' });
      return;
    }
    void readJson(req).then((body) => {
      const accepted = capsuleHub.complete(str(body.jobId) ?? '', {
        ok: body.ok === true,
        output: body.output,
        ...(str(body.error) ? { error: str(body.error) } : {}),
      });
      json(res, accepted ? 200 : 404, { accepted });
    });
    return;
  }

  // The autonomous patron's live activity: real jobs it hired + paid on-chain,
  // with no human in the loop. `activity` is read straight from the durable job
  // ledger (buyer = the patron), so it is never a cosmetic feed.
  if (pathname === '/api/patron/activity' && method === 'GET') {
    const activity = patron?.principal ? svc.recentJobsByBuyer(patron.principal, 20) : [];
    json(res, 200, {
      enabled: !!patron,
      patron: patron?.principal ?? null,
      stats: patron?.stats() ?? null,
      activity,
    });
    return;
  }

  if (pathname === '/api/listings' && method === 'GET') {
    json(res, 200, { listings: svc.listingsDecorated() });
    return;
  }

  if (pathname === '/api/listings/trending' && method === 'GET') {
    const n = Number(url.searchParams.get('n') ?? '4');
    json(res, 200, { listings: svc.trending(Number.isFinite(n) ? n : 4) });
    return;
  }

  if (pathname === '/api/favorites' && method === 'GET') {
    const identity = identityOf(req);
    if (!identity) {
      json(res, 401, { error: 'sign in to see your favorites' });
      return;
    }
    json(res, 200, { listings: svc.favoritesDecorated(identity), ids: svc.favoriteIdsOf(identity) });
    return;
  }

  if (pathname === '/api/listings' && method === 'POST') {
    const identity = identityOf(req);
    if (!identity) {
      json(res, 401, { error: 'sign in with your wallet to publish a listing' });
      return;
    }
    void readJson(req).then((body) => {
      try {
        const channelKind = str(body.channelKind) ?? 'webhook';
        const channel =
          channelKind === 'capsule'
            ? { kind: 'capsule' as const, ref: str(body.capsuleRef) ?? '' }
            : { kind: 'webhook' as const, url: str(body.webhookUrl) ?? '' };
        const listing = svc.publishListing(
          {
            title: str(body.title) ?? '',
            description: str(body.description) ?? '',
            category: str(body.category) ?? 'other',
            priceUct: Number(body.priceUct),
            channel,
            ...(parseInputSchema(body.inputSchema) ? { inputSchema: parseInputSchema(body.inputSchema) } : {}),
          },
          identity,
        );
        // Broadcast the new listing to Unicity's decentralized market feed so it
        // is discoverable network-wide (best-effort; never blocks the response).
        void market?.publish(listing);
        // Probe the provider endpoint so the publish response can tell the owner
        // whether their agent is reachable (the verified badge). The webhook
        // secret is returned ONCE here - there is no endpoint to read it later.
        void svc.verifyListingHealth(listing.id).then((health) => {
          json(res, 200, {
            listing: svc.decorateListing(listing),
            webhookSecret: svc.webhookSecretFor(listing.id),
            health,
          });
        });
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : 'could not publish listing' });
      }
    });
    return;
  }

  const testMatch = pathname.match(/^\/api\/listings\/([^/]+)\/test$/);
  if (testMatch && method === 'POST') {
    const identity = identityOf(req);
    if (!identity) {
      json(res, 401, { error: 'sign in as the listing owner to run a test' });
      return;
    }
    void readJson(req).then((body) => {
      svc
        .testInvoke(decodeURIComponent(testMatch[1]!), identity, body.input)
        .then((result) => json(res, 200, { result }))
        .catch((e) => json(res, 400, { error: e instanceof Error ? e.message : 'test invocation failed' }));
    });
    return;
  }

  const healthMatch = pathname.match(/^\/api\/listings\/([^/]+)\/health$/);
  if (healthMatch && method === 'POST') {
    const identity = identityOf(req);
    if (!identity) {
      json(res, 401, { error: 'sign in as the listing owner to re-check health' });
      return;
    }
    const listingId = decodeURIComponent(healthMatch[1]!);
    const owner = svc.listingOwner(listingId);
    if (owner?.chainPubkey && owner.chainPubkey !== identity.chainPubkey) {
      json(res, 403, { error: 'only the listing owner can re-check its health' });
      return;
    }
    svc
      .verifyListingHealth(listingId)
      .then((health) => json(res, 200, { health }))
      .catch((e) => json(res, 400, { error: e instanceof Error ? e.message : 'health check failed' }));
    return;
  }

  const favMatch = pathname.match(/^\/api\/listings\/([^/]+)\/favorite$/);
  if (favMatch && method === 'POST') {
    const identity = identityOf(req);
    if (!identity) {
      json(res, 401, { error: 'sign in to favorite a listing' });
      return;
    }
    try {
      json(res, 200, svc.toggleFavorite(decodeURIComponent(favMatch[1]!), identity));
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : 'could not favorite' });
    }
    return;
  }

  const listingMatch = pathname.match(/^\/api\/listings\/([^/]+)$/);
  if (listingMatch && method === 'GET') {
    const listing = svc.getListing(decodeURIComponent(listingMatch[1]!));
    if (!listing) {
      json(res, 404, { error: 'no such listing' });
      return;
    }
    json(res, 200, { listing: svc.decorateListing(listing) });
    return;
  }

  if (pathname === '/api/hire' && method === 'POST') {
    const identity = identityOf(req);
    if (!identity) {
      json(res, 401, { error: 'sign in with your wallet to hire an agent' });
      return;
    }
    void readJson(req).then((body) => {
      try {
        const out = svc.hire({
          listingId: str(body.listingId) ?? '',
          buyer: identity,
          input: body.input,
          ...(str(body.parentJobId) ? { parentJobId: str(body.parentJobId) } : {}),
          ...(str(body.mandateId) ? { mandateId: str(body.mandateId) } : {}),
        });
        json(res, 200, out);
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : 'could not hire' });
      }
    });
    return;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(accept|dispute|resolve|review))?$/);
  if (jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]!);
    const action = jobMatch[2];
    if (!action && method === 'GET') {
      const view = svc.getJob(jobId);
      if (!view) {
        json(res, 404, { error: 'no such job' });
        return;
      }
      json(res, 200, view);
      return;
    }
    if (action && method === 'POST') {
      const identity = identityOf(req);
      if (!identity) {
        json(res, 401, { error: 'sign in with your wallet to act on a job' });
        return;
      }
      void readJson(req).then((body) => {
        try {
          if (action === 'accept') {
            json(res, 200, { job: svc.acceptJob(jobId, identity) });
          } else if (action === 'dispute') {
            json(res, 200, { job: svc.disputeJob(jobId, identity) });
          } else if (action === 'review') {
            const review = svc.postReview(
              { jobId, stars: Number(body.stars), text: str(body.text) },
              identity,
            );
            json(res, 200, { review });
          } else {
            if (!env.auth.operators.includes(identity.chainPubkey)) {
              json(res, 403, { error: 'only a bazaar operator can resolve disputes' });
              return;
            }
            json(res, 200, {
              job: svc.resolveDispute(jobId, str(body.outcome) === 'refund' ? 'refund' : 'release'),
            });
          }
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : 'action failed' });
        }
      });
      return;
    }
  }

  const repMatch = pathname.match(/^\/api\/reputation\/([^/]+)$/);
  if (repMatch && method === 'GET') {
    json(res, 200, { reputation: svc.reputationOf(decodeURIComponent(repMatch[1]!)) });
    return;
  }

  const reviewsMatch = pathname.match(/^\/api\/reviews\/(.+)$/);
  if (reviewsMatch && method === 'GET') {
    json(res, 200, { reviews: svc.reviewsOf(decodeURIComponent(reviewsMatch[1]!)) });
    return;
  }

  const profileMatch = pathname.match(/^\/api\/profile\/(.+)$/);
  if (profileMatch && method === 'GET') {
    const raw = decodeURIComponent(profileMatch[1]!);
    if (raw === 'me') {
      const identity = identityOf(req);
      if (!identity) {
        json(res, 401, { error: 'not signed in' });
        return;
      }
      json(res, 200, { profile: svc.profileOf(principalOf(identity)) });
      return;
    }
    json(res, 200, { profile: svc.profileOf(raw) });
    return;
  }

  // Trust score (JSON) for a provider.
  const trustMatch = pathname.match(/^\/api\/trust\/(.+)$/);
  if (trustMatch && method === 'GET') {
    json(res, 200, { trust: svc.trustOf(decodeURIComponent(trustMatch[1]!)) });
    return;
  }

  // Embeddable trust badge (SVG); providers put this on their own site.
  const badgeMatch = pathname.match(/^\/api\/badge\/(.+)\.svg$/);
  if (badgeMatch && method === 'GET') {
    const principal = toPrincipal(decodeURIComponent(badgeMatch[1]!));
    const t = svc.trustOf(principal);
    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
    });
    res.end(renderBadge(principal, t.score, t.tier));
    return;
  }

  // A2A Agent Card for a listing (interop with the agent2agent ecosystem).
  const cardMatch = pathname.match(/^\/api\/listings\/([^/]+)\/agent-card$/);
  if (cardMatch && method === 'GET') {
    const listing = svc.getListing(decodeURIComponent(cardMatch[1]!));
    if (!listing) {
      json(res, 404, { error: 'no such listing' });
      return;
    }
    const decorated = svc.decorateListing(listing);
    json(
      res,
      200,
      buildAgentCard(decorated, svc.trustOf(listing.agentNametag), baseUrlOf(req), env.publicUrl ?? baseUrlOf(req)),
    );
    return;
  }

  // ---- spending mandates (AP2-style delegated budgets) ----
  if (pathname === '/api/mandates' && method === 'POST') {
    void readJson(req).then((body) => {
      try {
        const signed = body as unknown as {
          mandate?: unknown;
          signature?: unknown;
          signer?: unknown;
        };
        if (!signed.mandate || typeof signed.signature !== 'string' || typeof signed.signer !== 'string') {
          json(res, 400, { error: 'expected { mandate, signature, signer }' });
          return;
        }
        const mandate = svc.registerMandate({
          mandate: signed.mandate as never,
          signature: signed.signature,
          signer: signed.signer,
        });
        json(res, 200, { mandate, status: svc.mandateStatusOf(mandate.mandateId) });
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : 'could not register mandate' });
      }
    });
    return;
  }
  const mandateMatch = pathname.match(/^\/api\/mandates\/([^/]+)$/);
  if (mandateMatch && method === 'GET') {
    const status = svc.mandateStatusOf(decodeURIComponent(mandateMatch[1]!));
    if (!status) {
      json(res, 404, { error: 'no such mandate' });
      return;
    }
    json(res, 200, { status });
    return;
  }

  // ---- Unicity decentralized market feed ----
  if (pathname === '/api/market/status' && method === 'GET') {
    json(res, 200, { enabled: env.market, available: market?.available ?? false });
    return;
  }
  if (pathname === '/api/market/feed' && method === 'GET') {
    const n = Math.min(50, Math.max(1, Number(url.searchParams.get('n')) || 24));
    void (market?.feed(n) ?? Promise.resolve([])).then((items) =>
      json(res, 200, { items, available: market?.available ?? false }),
    );
    return;
  }
  if (pathname === '/api/market/search' && method === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    void (market?.search(q) ?? Promise.resolve([])).then((items) =>
      json(res, 200, { items, available: market?.available ?? false }),
    );
    return;
  }
  if (pathname === '/api/market/rates' && method === 'GET') {
    void (market?.rates() ?? Promise.resolve([])).then((rates) =>
      json(res, 200, { rates, available: market?.available ?? false }),
    );
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(env.port, () => {
  log.info(`listening on :${env.port}`);
  boot().catch((e) => {
    log.error('boot failed', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
});
