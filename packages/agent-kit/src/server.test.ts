import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type http from 'node:http';
import { createAgentServer, runInvocation, verifyWebhook, type AgentHandler } from './server.js';
import type { ServiceInvocation } from '@bazaar/core';

const inv = (input: unknown): ServiceInvocation => ({
  jobId: 'j1',
  listingId: 'l1',
  buyerNametag: '@buyer',
  input,
  amountUct: 1,
  escrowRef: 'esc_1',
});

// Mirror of the backend's webhook-client signing, so tests exercise the real wire format.
const signHeader = (secret: string, body: string, t = Date.now()): string =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

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

describe('verifyWebhook', () => {
  const secret = 'sh_test_secret';

  it('accepts a signature the backend would produce', () => {
    const body = JSON.stringify(inv('hi'));
    expect(verifyWebhook({ secret, rawBody: body, signatureHeader: signHeader(secret, body) })).toBe(true);
  });

  it('rejects a body that was tampered with after signing', () => {
    const signed = JSON.stringify(inv('hi'));
    const header = signHeader(secret, signed);
    const tampered = JSON.stringify(inv('MALICIOUS'));
    expect(verifyWebhook({ secret, rawBody: tampered, signatureHeader: header })).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const body = JSON.stringify(inv('hi'));
    expect(verifyWebhook({ secret: 'nope', rawBody: body, signatureHeader: signHeader(secret, body) })).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyWebhook({ secret, rawBody: '{}', signatureHeader: undefined })).toBe(false);
  });

  it('rejects a stale timestamp (replay)', () => {
    const body = JSON.stringify(inv('hi'));
    const old = Date.now() - 10 * 60_000;
    expect(verifyWebhook({ secret, rawBody: body, signatureHeader: signHeader(secret, body, old) })).toBe(false);
  });
});

describe('createAgentServer (integration)', () => {
  let server: http.Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  const start = (handle: AgentHandler, secret?: string): Promise<number> =>
    new Promise((resolve) => {
      server = createAgentServer({ handle, port: 0, secret, onListening: (port) => resolve(port) });
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

  it('401s an unsigned call when a secret is configured', async () => {
    const port = await start((i) => ({ echoed: i.input }), 'sh_secret');
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inv('hi')),
    });
    expect(res.status).toBe(401);
  });

  it('accepts a properly signed call when a secret is configured', async () => {
    const secret = 'sh_secret';
    const port = await start((i) => ({ echoed: i.input }), secret);
    const body = JSON.stringify(inv('hi'));
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bazaar-signature': signHeader(secret, body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: 'j1', ok: true, output: { echoed: 'hi' } });
  });
});
