import { describe, expect, it, vi } from 'vitest';
import { BazaarClient, type Funder, type Signer } from './client.js';

const jsonRes = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const signer: Signer = { chainPubkey: `02${'a'.repeat(64)}`, nametag: 'agent', sign: () => 'sig' };

describe('BazaarClient', () => {
  it('reads listings and surfaces backend errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(200, { listings: [{ id: 'l1' }] }));
    const c = new BazaarClient('http://api/', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await c.listings())[0]?.id).toBe('l1');

    const bad = new BazaarClient('http://api', {
      fetchImpl: vi.fn().mockResolvedValueOnce(jsonRes(404, { error: 'no such listing' })) as unknown as typeof fetch,
    });
    await expect(bad.listing('x')).rejects.toThrow(/no such listing/);
  });

  it('re-authenticates once on 401 then retries with the token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(401, { error: 'sign in' }))
      .mockResolvedValueOnce(jsonRes(200, { nonce: 'n', message: 'm', expiresAt: 0 }))
      .mockResolvedValueOnce(jsonRes(200, { token: 'tok' }))
      .mockResolvedValueOnce(jsonRes(200, { job: { jobId: 'j', state: 'released' } }));
    const c = new BazaarClient('http://api', { signer, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect((await c.accept('j')).state).toBe('released');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect((fetchImpl.mock.calls[3]![1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
  });

  it('passes parentJobId + mandateId through on hire', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(200, { job: { jobId: 'child' } }));
    const c = new BazaarClient('http://api', { fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.hire('listingB', { x: 1 }, { parentJobId: 'parentJob', mandateId: 'mand-1' });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      listingId: 'listingB',
      input: { x: 1 },
      parentJobId: 'parentJob',
      mandateId: 'mand-1',
    });
  });

  it('hireAndSettle: hires, funds, waits for delivery, and accepts', async () => {
    const funder = vi.fn<Funder>().mockResolvedValue(undefined);
    // hire -> pay(job:quoted) -> depositInfo -> job(funded) -> job(delivered) -> accept -> job(released)
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { job: { jobId: 'j', escrowRef: 'e', state: 'quoted', amountUct: 5 } })) // hire
      .mockResolvedValueOnce(jsonRes(200, { job: { jobId: 'j', escrowRef: 'e', state: 'quoted', amountUct: 5 } })) // pay->job
      .mockResolvedValueOnce(jsonRes(200, { escrow: '@escrow', coinId: 'c', decimals: 2, symbol: 'UCT' })) // depositInfo
      .mockResolvedValueOnce(jsonRes(200, { job: { jobId: 'j', state: 'delivered', amountUct: 5 }, result: { ok: true, output: 42 } })) // poll
      .mockResolvedValueOnce(jsonRes(200, { job: { jobId: 'j', state: 'released' } })) // accept
      .mockResolvedValueOnce(jsonRes(200, { job: { jobId: 'j', state: 'released', amountUct: 5 }, result: { ok: true, output: 42 } })); // final job
    const c = new BazaarClient('http://api', {
      signer,
      funder,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const view = await c.hireAndSettle('listingB', { q: 1 }, { parentJobId: 'p', pollMs: 1 });
    expect(view.job.state).toBe('released');
    expect(view.result?.output).toBe(42);
    // funded exactly the escrow with the job's memo
    expect(funder).toHaveBeenCalledWith('@escrow', 5, 'e');
    // lineage tag went out on the hire
    const hireBody = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(hireBody.parentJobId).toBe('p');
  });
});
