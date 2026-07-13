import { describe, expect, it } from 'vitest';
import { makeListing, type ServiceInvocation } from '@bazaar/core';
import { BazaarService, type BazaarAgent } from './bazaar-service.js';
import { CapsuleHub } from './capsule-hub.js';
import type { Identity } from './auth.js';

const SECRET = 's3cret-s3cret-s3cret';

const inv = (jobId: string): ServiceInvocation => ({
  jobId,
  listingId: 'l1',
  buyerNametag: '@buyer',
  input: { game: 'coin' },
  amountUct: 2,
  escrowRef: `esc-${jobId}`,
});

describe('CapsuleHub - the kind:capsule mailbox', () => {
  it('parks a job, leases it once, and resolves on complete', async () => {
    const hub = new CapsuleHub({ secret: SECRET });
    const done = hub.enqueue('arcade-player', inv('j1'));
    // First poll leases the invocation; a second poll must not re-lease it.
    expect(hub.lease('arcade-player').map((i) => i.jobId)).toEqual(['j1']);
    expect(hub.lease('arcade-player')).toEqual([]);
    expect(hub.complete('j1', { ok: true, output: { round: 'won' } })).toBe(true);
    await expect(done).resolves.toMatchObject({ jobId: 'j1', ok: true, output: { round: 'won' } });
  });

  it('only leases work addressed to the polling ref', () => {
    const hub = new CapsuleHub({ secret: SECRET });
    void hub.enqueue('arcade-player', inv('j-a'));
    void hub.enqueue('other-capsule', inv('j-b'));
    expect(hub.lease('arcade-player').map((i) => i.jobId)).toEqual(['j-a']);
    expect(hub.lease('other-capsule').map((i) => i.jobId)).toEqual(['j-b']);
  });

  it('times out into a refundable failure when the capsule never answers', async () => {
    const hub = new CapsuleHub({ secret: SECRET, resultTimeoutMs: 30 });
    const done = hub.enqueue('arcade-player', inv('j2'));
    await expect(done).resolves.toMatchObject({ ok: false, error: expect.stringContaining('offline or timed out') });
    // Too late now - the job is gone.
    expect(hub.complete('j2', { ok: true })).toBe(false);
  });

  it('authorizes with a constant-time secret check', () => {
    const hub = new CapsuleHub({ secret: SECRET });
    expect(hub.authorized(SECRET)).toBe(true);
    expect(hub.authorized('wrong')).toBe(false);
    expect(hub.authorized(undefined)).toBe(false);
  });

  it('reports liveness from inbox polls', () => {
    const hub = new CapsuleHub({ secret: SECRET, livenessWindowMs: 60_000 });
    expect(hub.health('arcade-player').ok).toBe(false); // never polled
    hub.lease('arcade-player');
    expect(hub.health('arcade-player').ok).toBe(true);
  });
});

describe('capsule channel through the whole escrow flow', () => {
  const stubAgent = (sent: { recipient: string; amount: number }[]): BazaarAgent => ({
    nametag: 'bazaar-escrow',
    uctCoin: { coinId: 'aabb', decimals: 2 },
    toHuman: (smallest) => (Number(BigInt(smallest)) / 100).toString(),
    send: async (recipient, amount) => {
      sent.push({ recipient: String(recipient), amount: Number(amount) });
      return { id: 'tx' };
    },
  });

  it('hire -> fund -> park -> lease -> complete -> delivered -> release', async () => {
    const hub = new CapsuleHub({ secret: SECRET });
    const sent: { recipient: string; amount: number }[] = [];
    const svc = new BazaarService({
      agent: stubAgent(sent),
      // Mirrors the production wiring: capsule channels park in the hub.
      invoke: (channel, invocation) =>
        channel.kind === 'capsule'
          ? hub.enqueue(channel.ref, invocation)
          : Promise.resolve({ jobId: invocation.jobId, ok: false, error: 'unexpected webhook' }),
      capsuleHealth: (ref) => hub.health(ref),
    });
    const owner: Identity = { chainPubkey: `02${'a'.repeat(64)}`, nametag: 'astrid-arcade' };
    const listing = makeListing(
      {
        agentNametag: '@astrid-arcade',
        title: 'Arcade Oracle - capsule test',
        description: 'a provably-fair round from a sandboxed capsule, for the integration test',
        category: 'game',
        priceUct: 2,
        channel: { kind: 'capsule', ref: 'arcade-player' },
      },
      1_700_000_000_004,
    );
    svc.seedListing(listing, owner, SECRET);

    const buyer: Identity = { chainPubkey: `03${'b'.repeat(64)}`, nametag: 'tester' };
    const hire = svc.hire({ listingId: listing.id, buyer, input: { game: 'coin' } });
    svc.creditFunding({ dedupKey: 'f1', amountBase: '200', memo: hire.memo });

    // The job is parked, not delivered - the capsule hasn't polled yet.
    expect(svc.getJob(hire.job.jobId)!.job.state).toBe('funded');

    // The capsule polls its inbox, does the work, posts the result.
    const leased = hub.lease('arcade-player');
    expect(leased.map((i) => i.jobId)).toEqual([hire.job.jobId]);
    expect(hub.complete(hire.job.jobId, { ok: true, output: { outcome: 'win', fair: true } })).toBe(true);
    await svc.flushJobs();

    const view = svc.getJob(hire.job.jobId)!;
    expect(view.job.state).toBe('delivered');
    expect(view.result).toMatchObject({ ok: true, output: { outcome: 'win', fair: true } });

    // Health now reflects the poll - the listing can wear the verified badge.
    expect((await svc.verifyListingHealth(listing.id)).ok).toBe(true);

    // Buyer accepts; settlement pays the proven provider key.
    svc.acceptJob(hire.job.jobId, buyer);
    await svc.flushPayouts();
    expect(sent).toEqual([{ recipient: owner.chainPubkey, amount: 2 }]);
  });

  it('an offline capsule refunds the buyer instead of hanging', async () => {
    const hub = new CapsuleHub({ secret: SECRET, resultTimeoutMs: 30 });
    const sent: { recipient: string; amount: number }[] = [];
    const svc = new BazaarService({
      agent: stubAgent(sent),
      invoke: (channel, invocation) =>
        channel.kind === 'capsule'
          ? hub.enqueue(channel.ref, invocation)
          : Promise.resolve({ jobId: invocation.jobId, ok: false, error: 'unexpected webhook' }),
    });
    const owner: Identity = { chainPubkey: `02${'a'.repeat(64)}`, nametag: 'astrid-arcade' };
    const listing = makeListing(
      {
        agentNametag: '@astrid-arcade',
        title: 'Arcade Oracle - offline test',
        description: 'capsule never polls; the escrow must refund the buyer honestly',
        category: 'game',
        priceUct: 2,
        channel: { kind: 'capsule', ref: 'arcade-player' },
      },
      1_700_000_000_005,
    );
    svc.seedListing(listing, owner, SECRET);
    const buyer: Identity = { chainPubkey: `03${'b'.repeat(64)}`, nametag: 'tester' };
    const hire = svc.hire({ listingId: listing.id, buyer, input: {} });
    svc.creditFunding({ dedupKey: 'f2', amountBase: '200', memo: hire.memo });
    await svc.flushJobs();
    await svc.flushPayouts();
    const view = svc.getJob(hire.job.jobId)!;
    expect(view.job.state).toBe('refunded');
    expect(sent).toEqual([{ recipient: buyer.chainPubkey, amount: 2 }]);
  });
});
