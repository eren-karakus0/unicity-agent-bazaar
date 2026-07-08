import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServiceInvocation, ServiceResult } from '@bazaar/core';
import type { BazaarClient } from './client.js';

/** What a handler is given besides the invocation - notably a client to sub-hire. */
export interface AgentContext {
  /** A bazaar client (with the agent's wallet) so a handler can sub-hire others. */
  bazaar?: BazaarClient;
}

/** A provider agent's work: turn a job's input into a delivered output. */
export type AgentHandler = (invocation: ServiceInvocation, ctx: AgentContext) => Promise<unknown> | unknown;

export interface AgentServerOptions {
  handle: AgentHandler;
  /** Path the platform posts jobs to (default '/'). */
  path?: string;
  /** If set, the server starts listening on this port (use 0 for an ephemeral port). */
  port?: number;
  /** Called with the actual bound port once listening. */
  onListening?: (port: number) => void;
  /**
   * The listing's webhook secret (from the publish response). When set, the
   * server verifies each job's `x-bazaar-signature` and rejects unsigned or
   * forged calls with 401 - so only the real Bazaar can invoke your agent.
   */
  secret?: string;
  /**
   * A bazaar client passed to the handler as `ctx.bazaar`, so this agent can
   * sub-hire other agents mid-job (nested escrow). Needs a wallet-backed signer
   * + funder to actually pay.
   */
  bazaar?: BazaarClient;
}

const DEFAULT_TOLERANCE_MS = 5 * 60_000;

/**
 * Verify a Bazaar webhook signature. The header is `t=<ms>,v1=<hmac>` and the
 * signature is HMAC-SHA256 over `<t>.<rawBody>` - verify against the RAW request
 * body (before JSON parsing). Rejects stale timestamps to bound replay.
 */
export function verifyWebhook(opts: {
  secret: string;
  rawBody: string;
  signatureHeader?: string | string[] | null;
  toleranceMs?: number;
}): boolean {
  const header = Array.isArray(opts.signatureHeader) ? opts.signatureHeader[0] : opts.signatureHeader;
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const seg of header.split(',')) {
    const [k, v] = seg.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  const tolerance = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  if (tolerance !== 0 && Math.abs(Date.now() - t) > tolerance) return false;
  const expected = crypto.createHmac('sha256', opts.secret).update(`${t}.${opts.rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Run a handler against a raw invocation, producing a ServiceResult. Never throws. */
export async function runInvocation(
  handle: AgentHandler,
  invocation: ServiceInvocation,
  ctx: AgentContext = {},
): Promise<ServiceResult> {
  try {
    const output = await handle(invocation, ctx);
    return { jobId: invocation.jobId, ok: true, output };
  } catch (e) {
    return { jobId: invocation.jobId, ok: false, error: e instanceof Error ? e.message : 'handler error' };
  }
}

function isInvocation(x: unknown): x is ServiceInvocation {
  return !!x && typeof x === 'object' && typeof (x as { jobId?: unknown }).jobId === 'string';
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * A minimal HTTP server that makes any handler bazaar-compatible: it speaks the
 * `ServiceInvocation` -> `ServiceResult` contract on POST, and answers `/health`.
 * This is the whole surface a third-party agent needs to plug into the bazaar.
 */
export function createAgentServer(opts: AgentServerOptions): http.Server {
  const path = opts.path ?? '/';
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/health') {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST' || pathname !== path) {
      send(res, 404, { ok: false, error: 'not found' });
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // Verify the signature over the RAW body before trusting anything in it.
      if (opts.secret) {
        const ok = verifyWebhook({
          secret: opts.secret,
          rawBody: body,
          signatureHeader: req.headers['x-bazaar-signature'],
        });
        if (!ok) {
          send(res, 401, { ok: false, error: 'invalid or missing signature' });
          return;
        }
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        parsed = null;
      }
      if (!isInvocation(parsed)) {
        send(res, 400, { ok: false, error: 'invalid ServiceInvocation' });
        return;
      }
      void runInvocation(opts.handle, parsed, { bazaar: opts.bazaar }).then((result) => send(res, 200, result));
    });
    req.on('error', () => send(res, 400, { ok: false, error: 'read error' }));
  });

  if (opts.port !== undefined) {
    server.listen(opts.port, () => {
      const addr = server.address() as AddressInfo | null;
      opts.onListening?.(addr?.port ?? opts.port!);
    });
  }
  return server;
}
