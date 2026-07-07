/**
 * Unicity Agent Bazaar — backend.
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
import { loadEnv } from './config.js';
import { createLogger } from './logger.js';
import { SphereAgent } from './sphere-agent.js';
import { BazaarService, type BazaarSnapshot } from './bazaar-service.js';
import { AuthService, principalOf, type Identity } from './auth.js';
import { createWebhookInvoker } from './webhook-client.js';
import { loadSnapshot, saveSnapshot } from './persist.js';

const env = loadEnv();
const log = createLogger('backend');

const auth = new AuthService({
  sessionSecret: env.auth.sessionSecret,
  sessionTtlMs: env.auth.sessionTtlMs,
  verify: verifySignedMessage,
  logger: createLogger('auth'),
});
if (env.auth.secretIsEphemeral) {
  log.warn('BAZAAR_SESSION_SECRET is unset — using a random per-boot secret; logins reset on restart.');
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
  logger: createLogger('escrow'),
});

let service: BazaarService | null = null;
let ready = false;

const snapshotFile = path.join(env.dataRoot, 'bazaar-state.json');

async function boot(): Promise<void> {
  await escrowAgent.start();
  service = new BazaarService({
    agent: escrowAgent,
    invoke: createWebhookInvoker({ timeoutMs: 20_000 }),
    autoReleaseMs: env.autoReleaseMs,
    logger: createLogger('bazaar'),
  });

  // Restore prior marketplace state, then persist periodically + on shutdown.
  const restored = loadSnapshot<BazaarSnapshot>(snapshotFile);
  if (restored) {
    service.restore(restored);
    log.info(`restored marketplace state (${restored.listings?.length ?? 0} listings, ${restored.jobs?.length ?? 0} jobs)`);
  }
  const svcRef = service;
  setInterval(() => saveSnapshot(snapshotFile, svcRef.snapshot()), 10_000);
  const persistAndExit = () => {
    saveSnapshot(snapshotFile, svcRef.snapshot());
    process.exit(0);
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

  ready = true;
  log.info(`bazaar online — escrow @${escrowAgent.nametag}`);
}

// ---- http helpers ----
function setCors(res: http.ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  // `authorization` is REQUIRED here: signed-in requests carry a Bearer token,
  // which triggers a CORS preflight — omitting it blocks every authed fetch.
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

  if (!service || !ready) {
    json(res, 503, { error: 'The bazaar is still waking up — try again in a few seconds.' });
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
          },
          identity,
        );
        // The webhook secret is returned ONCE here so the provider can verify
        // signed job calls — there is no endpoint to read it back later.
        json(res, 200, { listing, webhookSecret: svc.webhookSecretFor(listing.id) });
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : 'could not publish listing' });
      }
    });
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

  json(res, 404, { error: 'not found' });
});

server.listen(env.port, () => {
  log.info(`listening on :${env.port}`);
  boot().catch((e) => {
    log.error('boot failed', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
});
