import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServiceInvocation, ServiceResult } from '@bazaar/core';

/** A provider agent's work: turn a job's input into a delivered output. */
export type AgentHandler = (invocation: ServiceInvocation) => Promise<unknown> | unknown;

export interface AgentServerOptions {
  handle: AgentHandler;
  /** Path the platform posts jobs to (default '/'). */
  path?: string;
  /** If set, the server starts listening on this port (use 0 for an ephemeral port). */
  port?: number;
  /** Called with the actual bound port once listening. */
  onListening?: (port: number) => void;
}

/** Run a handler against a raw invocation, producing a ServiceResult. Never throws. */
export async function runInvocation(
  handle: AgentHandler,
  invocation: ServiceInvocation,
): Promise<ServiceResult> {
  try {
    const output = await handle(invocation);
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
      void runInvocation(opts.handle, parsed).then((result) => send(res, 200, result));
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
