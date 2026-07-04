import { describe, expect, it } from 'vitest';
import type { DeliveryChannel, ServiceInvocation, ServiceResult } from '@bazaar/core';
import { BazaarService, type BazaarAgent, type PublishInput } from './bazaar-service.js';
import type { Identity } from './auth.js';
import type { Invoker } from './webhook-client.js';

const provider: Identity = { chainPubkey: `02${'a'.repeat(64)}`, nametag: 'scout' };
const buyer: Identity = { chainPubkey: `03${'b'.repeat(64)}`, nametag: 'buyer' };

interface Sent {
  recipient: string;
  amount: number;
  memo?: string;
}

/** A stub escrow agent: records sends, converts base units at 2 decimals. */
function stubAgent(sent: Sent[], opts?: { fail?: boolean }): BazaarAgent {
  return {
    nametag: 'bazaar-escrow',
    uctCoin: { coinId: 'aabb', decimals: 2 },
    toHuman: (smallest) => (Number(BigInt(smallest)) / 100).toString(),
    send: async (recipient, human, memo) => {
      if (opts?.fail) throw new Error('testnet down');
      sent.push({ recipient, amount: Number(human), memo });
      return { id: `tx-${sent.length}` };
    },
  };
}

/** An invoker that always succeeds / always fails / echoes input. */
function invoker(mode: 'ok' | 'fail'): Invoker {
  return async (_channel: DeliveryChannel, inv: ServiceInvocation): Promise<ServiceResult> =>
    mode === 'ok'
      ? { jobId: inv.jobId, ok: true, output: { echoed: inv.input } }
      : { jobId: inv.jobId, ok: false, error: 'provider blew up' };
}

const publishInput: PublishInput = {
  title: 'Repo risk scan',
  description: 'I scan a repo and return risk.',
  category: 'analysis',
  priceUct: 10,
  channel: { kind: 'webhook', url: 'https://scout.example.com/hook' },
};

function fund(svc: BazaarService, hire: { memo: string; amountUct: number }, dedupKey = 'd1') {
  // 10 UCT arrives as base units at 2 decimals = "1000".
  return svc.creditFunding({ dedupKey, amountBase: String(hire.amountUct * 100), memo: hire.memo });
}

describe('BazaarService — registry', () => {
  it('publishes and lists active listings', () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const l = svc.publishListing(publishInput, provider);
    expect(l.agentNametag).toBe('@scout');
    expect(svc.getListings().map((x) => x.id)).toContain(l.id);
    expect(svc.getListing(l.id)?.priceUct).toBe(10);
  });

  it('rejects an invalid listing', () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    expect(() => svc.publishListing({ ...publishInput, priceUct: 0 }, provider)).toThrow(/invalid listing/);
  });
});

describe('BazaarService — happy path (fund → deliver → release)', () => {
  it('funds, invokes, delivers, and releases to the provider on accept', async () => {
    const sent: Sent[] = [];
    const svc = new BazaarService({ agent: stubAgent(sent), invoke: invoker('ok') });
    const listing = svc.publishListing(publishInput, provider);
    const hire = svc.hire({ listingId: listing.id, buyer, input: { repo: 'x/y' } });
    expect(hire.memo).toBe(hire.job.escrowRef);
    expect(hire.payTo).toBe('@bazaar-escrow');

    const funded = fund(svc, hire);
    expect(funded?.state).toBe('funded');
    await svc.flushJobs();

    const delivered = svc.getJob(hire.job.jobId)!;
    expect(delivered.job.state).toBe('delivered');
    expect(delivered.result?.ok).toBe(true);

    svc.acceptJob(hire.job.jobId, buyer);
    await svc.flushPayouts();

    const done = svc.getJob(hire.job.jobId)!;
    expect(done.job.state).toBe('released');
    expect(done.settlement?.status).toBe('settled');
    // Settlement routes to the provider's PROVEN wallet key, not a claimed nametag.
    expect(sent).toEqual([{ recipient: provider.chainPubkey, amount: 10, memo: 'bazaar-release' }]);
    const rep = svc.reputationOf('@scout');
    expect(rep.jobsCompleted).toBe(1);
    expect(rep.volumeUct).toBe(10);
    expect(rep.successRate).toBe(1);
  });
});

describe('BazaarService — provider failure refunds the buyer', () => {
  it('refunds when the provider fails', async () => {
    const sent: Sent[] = [];
    const svc = new BazaarService({ agent: stubAgent(sent), invoke: invoker('fail') });
    const listing = svc.publishListing(publishInput, provider);
    const hire = svc.hire({ listingId: listing.id, buyer });
    fund(svc, hire);
    await svc.flushJobs();
    await svc.flushPayouts();

    const job = svc.getJob(hire.job.jobId)!;
    expect(job.job.state).toBe('refunded');
    expect(sent).toEqual([{ recipient: buyer.chainPubkey, amount: 10, memo: 'bazaar-refund' }]);
    expect(svc.reputationOf('@scout').jobsCompleted).toBe(0);
    expect(svc.reputationOf('@scout').successRate).toBe(0);
  });
});

describe('BazaarService — funding rules', () => {
  it('ignores a wrong memo, an underfunded amount, and a duplicate dedupKey', async () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const hire = svc.hire({ listingId: svc.publishListing(publishInput, provider).id, buyer });

    expect(svc.creditFunding({ dedupKey: 'x', amountBase: '1000', memo: 'nope' })).toBeNull();
    expect(svc.creditFunding({ dedupKey: 'y', amountBase: '500', memo: hire.memo })).toBeNull(); // 5 < 10 UCT

    const ok = fund(svc, hire, 'dup');
    expect(ok?.state).toBe('funded');
    // Same dedupKey again is a no-op (already funded / seen).
    expect(svc.creditFunding({ dedupKey: 'dup', amountBase: '1000', memo: hire.memo })).toBeNull();
    await svc.flushJobs();
  });
});

describe('BazaarService — auto-release', () => {
  it('auto-releases a delivered job after its window', async () => {
    const sent: Sent[] = [];
    const svc = new BazaarService({ agent: stubAgent(sent), invoke: invoker('ok'), autoReleaseMs: 1000 });
    const hire = svc.hire({ listingId: svc.publishListing(publishInput, provider).id, buyer });
    fund(svc, hire);
    await svc.flushJobs();

    svc.sweepAutoRelease(Date.now() - 10); // window not elapsed for a just-delivered job
    expect(svc.getJob(hire.job.jobId)!.job.state).toBe('delivered');

    svc.sweepAutoRelease(Date.now() + 5000); // well past the 1s window
    await svc.flushPayouts();
    expect(svc.getJob(hire.job.jobId)!.job.state).toBe('released');
    expect(sent[0]?.memo).toBe('bazaar-release');
  });
});

describe('BazaarService — dispute', () => {
  it('disputes a delivered job and resolves it as a refund', async () => {
    const sent: Sent[] = [];
    const svc = new BazaarService({ agent: stubAgent(sent), invoke: invoker('ok') });
    const hire = svc.hire({ listingId: svc.publishListing(publishInput, provider).id, buyer });
    fund(svc, hire);
    await svc.flushJobs();

    expect(svc.disputeJob(hire.job.jobId, buyer).state).toBe('disputed');
    svc.resolveDispute(hire.job.jobId, 'refund');
    await svc.flushPayouts();
    expect(svc.getJob(hire.job.jobId)!.job.state).toBe('refunded');
    expect(sent).toEqual([{ recipient: buyer.chainPubkey, amount: 10, memo: 'bazaar-refund' }]);
  });

  it('cannot accept a job that was never delivered', () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const hire = svc.hire({ listingId: svc.publishListing(publishInput, provider).id, buyer });
    expect(() => svc.acceptJob(hire.job.jobId, buyer)).toThrow(/illegal/);
  });

  it('rejects accept/dispute from someone who is not the buyer', async () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const hire = svc.hire({ listingId: svc.publishListing(publishInput, provider).id, buyer });
    fund(svc, hire);
    await svc.flushJobs();
    const stranger: Identity = { chainPubkey: `02${'c'.repeat(64)}` };
    expect(() => svc.acceptJob(hire.job.jobId, stranger)).toThrow(/only the buyer/);
    expect(() => svc.disputeJob(hire.job.jobId, stranger)).toThrow(/only the buyer/);
  });

  it('forbids hiring your own listing', () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const listing = svc.publishListing(publishInput, provider);
    expect(() => svc.hire({ listingId: listing.id, buyer: provider })).toThrow(/your own listing/);
  });
});
