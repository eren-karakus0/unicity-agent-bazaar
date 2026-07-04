import { afterEach, describe, expect, it } from 'vitest';
import type http from 'node:http';
import { createAgentServer, runInvocation, type AgentHandler } from './server.js';
import type { ServiceInvocation } from '@bazaar/core';

const inv = (input: unknown): ServiceInvocation => ({
  jobId: 'j1',
  listingId: 'l1',
  buyerNametag: '@buyer',
  input,
  amountUct: 1,
  escrowRef: 'esc_1',
});

describe('runInvocation', () => {
  it('wraps a handler result as ok', async () => {
    const r = await runInvocation((i) => ({ got: i.input }), inv(42));
    expect(r).toEqual({ jobId: 'j1', ok: true, output: { got: 42 } });
  });

  it('captures a thrown error as a failed result', async () => {
    const r = await runInvocation(() => {
      throw new Error('boom');
    }, inv(null));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
  });
});

describe('createAgentServer (integration)', () => {
  let server: http.Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  const start = (handle: AgentHandler): Promise<number> =>
    new Promise((resolve) => {
      server = createAgentServer({ handle, port: 0, onListening: (port) => resolve(port) });
    });

  it('serves a job and returns the result over HTTP', async () => {
    const port = await start((i) => ({ echoed: i.input }));
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inv('hi')),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: 'j1', ok: true, output: { echoed: 'hi' } });
  });

  it('400s on an invalid invocation', async () => {
    const port = await start(() => 'x');
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
  });

  it('answers a health probe', async () => {
    const port = await start(() => 'x');
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
