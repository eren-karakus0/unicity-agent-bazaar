import { afterEach, describe, expect, it, vi } from 'vitest';
import { BazaarClient, type Signer } from './client.js';

const jsonRes = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

afterEach(() => vi.unstubAllGlobals());

describe('BazaarClient', () => {
  it('reads listings from the API', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(200, { listings: [{ id: 'l1', title: 'T' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const c = new BazaarClient('http://api/');
    const ls = await c.listings();
    expect(ls[0]?.id).toBe('l1');
    expect(fetchMock).toHaveBeenCalledWith('http://api/api/listings', expect.objectContaining({ method: 'GET' }));
  });

  it('surfaces the backend error message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonRes(400, { error: 'unknown listing' })));
    const c = new BazaarClient('http://api');
    await expect(c.listing('nope')).rejects.toThrow(/unknown listing/);
  });

  it('re-authenticates once on a 401, then retries the original call', async () => {
    const signer: Signer = { chainPubkey: `02${'a'.repeat(64)}`, nametag: 'agent', sign: () => 'sig' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(401, { error: 'sign in' })) // accept -> 401
      .mockResolvedValueOnce(jsonRes(200, { nonce: 'n', message: 'm', expiresAt: 0 })) // challenge
      .mockResolvedValueOnce(jsonRes(200, { token: 'tok' })) // login
      .mockResolvedValueOnce(jsonRes(200, { job: { jobId: 'j', state: 'released' } })); // retry accept
    vi.stubGlobal('fetch', fetchMock);

    const c = new BazaarClient('http://api', signer);
    const r = await c.accept('j');
    expect(r.job.state).toBe('released');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // the retried accept carries the freshly minted token
    const lastCall = fetchMock.mock.calls[3]!;
    expect((lastCall[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
  });

  it('does not retry when no wallet/signer is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(401, { error: 'sign in' }));
    vi.stubGlobal('fetch', fetchMock);
    const c = new BazaarClient('http://api');
    await expect(c.accept('j')).rejects.toThrow(/sign in/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
