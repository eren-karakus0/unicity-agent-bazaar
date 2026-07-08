import { describe, expect, it } from 'vitest';
import type { DeliveryChannel, ServiceInvocation, ServiceResult } from '@bazaar/core';
import { canonicalReceipt } from '@bazaar/core';
import { getPublicKey, signMessage, verifySignedMessage } from '@unicitylabs/sphere-sdk';
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

describe('BazaarService - registry', () => {
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

describe('BazaarService - happy path (fund → deliver → release)', () => {
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

describe('BazaarService - provider failure refunds the buyer', () => {
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

describe('BazaarService - funding rules', () => {
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

describe('BazaarService - auto-release', () => {
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

describe('BazaarService - dispute', () => {
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

  it('requires a @nametag to publish', () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const bare: Identity = { chainPubkey: `02${'d'.repeat(64)}` };
    expect(() => svc.publishListing(publishInput, bare)).toThrow(/register a @nametag/);
  });
});

describe('BazaarService - profiles', () => {
  it('aggregates a principal’s listings, activity, and stats', async () => {
    const sent: Sent[] = [];
    const svc = new BazaarService({ agent: stubAgent(sent), invoke: invoker('ok') });
    const listing = svc.publishListing(publishInput, provider);
    const hire = svc.hire({ listingId: listing.id, buyer, input: { repo: 'x/y' } });
    fund(svc, hire);
    await svc.flushJobs();
    svc.acceptJob(hire.job.jobId, buyer);
    await svc.flushPayouts();

    const prov = svc.profileOf('@scout');
    expect(prov.nametag).toBe('scout');
    expect(prov.chainPubkey).toBe(provider.chainPubkey);
    expect(prov.listings.map((l) => l.id)).toContain(listing.id);
    expect(prov.stats.jobsAsProvider).toBe(1);
    expect(prov.stats.earnedUct).toBe(10);
    expect(prov.asProvider[0]?.state).toBe('released');
    expect(prov.asProvider[0]?.counterparty).toBe('@buyer');

    const buy = svc.profileOf('@buyer');
    expect(buy.stats.jobsAsBuyer).toBe(1);
    expect(buy.stats.spentUct).toBe(10);
    expect(buy.stats.listingsActive).toBe(0);
    expect(buy.asBuyer[0]?.counterparty).toBe('@scout');
  });
});

describe('BazaarService - reviews, favorites, trending', () => {
  async function releasedJob(svc: BazaarService) {
    const listing = svc.publishListing(publishInput, provider);
    const hire = svc.hire({ listingId: listing.id, buyer });
    fund(svc, hire);
    await svc.flushJobs();
    svc.acceptJob(hire.job.jobId, buyer);
    await svc.flushPayouts();
    return { listing, jobId: hire.job.jobId };
  }

  it('lets the buyer review a released job once, folding into reputation', async () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const { jobId } = await releasedJob(svc);

    const review = svc.postReview({ jobId, stars: 5, text: 'excellent' }, buyer);
    expect(review.stars).toBe(5);
    expect(svc.reviewsOf('@scout')).toHaveLength(1);
    expect(svc.reputationOf('@scout').avgRating).toBe(5);

    // one review per job
    expect(() => svc.postReview({ jobId, stars: 4 }, buyer)).toThrow(/already been reviewed/);
  });

  it('forbids reviews from non-buyers and on unfinished jobs', async () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const listing = svc.publishListing(publishInput, provider);
    const hire = svc.hire({ listingId: listing.id, buyer });
    // not released yet
    expect(() => svc.postReview({ jobId: hire.job.jobId, stars: 5 }, buyer)).toThrow(/released/);

    fund(svc, hire);
    await svc.flushJobs();
    svc.acceptJob(hire.job.jobId, buyer);
    await svc.flushPayouts();
    const stranger: Identity = { chainPubkey: `02${'c'.repeat(64)}` };
    expect(() => svc.postReview({ jobId: hire.job.jobId, stars: 5 }, stranger)).toThrow(/only the buyer/);
  });

  it('toggles favorites and surfaces them + trending', async () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const { listing } = await releasedJob(svc);

    const on = svc.toggleFavorite(listing.id, buyer);
    expect(on).toEqual({ favorited: true, favorites: 1 });
    expect(svc.favoriteIdsOf(buyer)).toContain(listing.id);
    expect(svc.favoritesDecorated(buyer).map((l) => l.id)).toContain(listing.id);

    const off = svc.toggleFavorite(listing.id, buyer);
    expect(off).toEqual({ favorited: false, favorites: 0 });

    // a released job = economic activity → trending picks it up
    expect(svc.trending().map((l) => l.id)).toContain(listing.id);
    expect(svc.listingsDecorated()[0]?.jobsCompleted).toBe(1);
  });
});

describe('BazaarService - publish hardening (health + test invoke)', () => {
  it('marks a reachable listing verified and probes its /health sibling', async () => {
    const probed: string[] = [];
    const svc = new BazaarService({
      agent: stubAgent([]),
      invoke: invoker('ok'),
      probe: async (url) => {
        probed.push(url);
        return { ok: true };
      },
    });
    const listing = svc.publishListing(publishInput, provider);
    const health = await svc.verifyListingHealth(listing.id);
    expect(health.ok).toBe(true);
    // /health sits at the root of the provider host, not under the job path.
    expect(probed).toEqual(['https://scout.example.com/health']);
    expect(svc.decorateListing(listing).verified).toBe(true);
  });

  it('records an unreachable endpoint without verifying it', async () => {
    const svc = new BazaarService({
      agent: stubAgent([]),
      invoke: invoker('ok'),
      probe: async () => ({ ok: false, detail: 'unreachable' }),
    });
    const listing = svc.publishListing(publishInput, provider);
    const health = await svc.verifyListingHealth(listing.id);
    expect(health).toMatchObject({ ok: false, detail: 'unreachable' });
    expect(svc.decorateListing(listing).verified).toBe(false);
  });

  it('auto-deactivates a listing after repeated failed health checks, resetting on recovery', async () => {
    let up = true;
    const svc = new BazaarService({
      agent: stubAgent([]),
      invoke: invoker('ok'),
      probe: async () => (up ? { ok: true } : { ok: false, detail: 'down' }),
    });
    const listing = svc.publishListing(publishInput, provider);

    up = false;
    await svc.sweepListingHealth(3); // strike 1
    await svc.sweepListingHealth(3); // strike 2
    expect(svc.getListing(listing.id)?.active).toBe(true);
    up = true;
    await svc.sweepListingHealth(3); // recovery resets the streak
    up = false;
    await svc.sweepListingHealth(3); // strike 1 again
    await svc.sweepListingHealth(3); // strike 2
    expect(svc.getListing(listing.id)?.active).toBe(true);
    await svc.sweepListingHealth(3); // strike 3 → deactivated
    expect(svc.getListing(listing.id)?.active).toBe(false);
  });

  it('runs an unpaid test invocation for the owner and blocks non-owners', async () => {
    let seen: ServiceInvocation | undefined;
    const svc = new BazaarService({
      agent: stubAgent([]),
      invoke: async (_c, inv) => {
        seen = inv;
        return { jobId: inv.jobId, ok: true, output: { pong: inv.input } };
      },
    });
    const listing = svc.publishListing(publishInput, provider);

    const result = await svc.testInvoke(listing.id, provider, { ping: 1 });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ pong: { ping: 1 } });
    // A test carries no escrow: zero amount + a `test-` ref, so agents can tell.
    expect(seen?.amountUct).toBe(0);
    expect(seen?.escrowRef.startsWith('test-')).toBe(true);

    await expect(svc.testInvoke(listing.id, buyer, {})).rejects.toThrow(/only the listing owner/);
  });
});

describe('BazaarService - settlement receipts (on-chain proof)', () => {
  const ESCROW_PRIV = 'a'.repeat(64);
  const ESCROW_PUB = getPublicKey(ESCROW_PRIV, true);

  // A stub escrow agent that can also sign receipts with a known key.
  const signingAgent = (sent: Sent[]): BazaarAgent => ({
    ...stubAgent(sent),
    chainPubkey: ESCROW_PUB,
    signMessage: (m) => signMessage(ESCROW_PRIV, m),
  });

  it('mints a receipt on release that verifies against the escrow key', async () => {
    const svc = new BazaarService({ agent: signingAgent([]), invoke: invoker('ok') });
    const listing = svc.publishListing(publishInput, provider);
    const hire = svc.hire({ listingId: listing.id, buyer });
    fund(svc, hire);
    await svc.flushJobs();
    svc.acceptJob(hire.job.jobId, buyer);
    await svc.flushPayouts();

    const view = svc.getJob(hire.job.jobId)!;
    expect(view.receipt).toBeDefined();
    const { receipt, signature, signer } = view.receipt!;
    expect(receipt.outcome).toBe('release');
    expect(receipt.recipient).toBe(provider.chainPubkey);
    expect(signer).toBe(ESCROW_PUB);
    // independently verifiable, and tamper-evident
    expect(verifySignedMessage(canonicalReceipt(receipt), signature, signer)).toBe(true);
    expect(verifySignedMessage(canonicalReceipt({ ...receipt, amountUct: 999 }), signature, signer)).toBe(false);
  });

  it('signs a refund receipt too, and survives snapshot/restore', async () => {
    const svc = new BazaarService({ agent: signingAgent([]), invoke: invoker('fail') });
    const listing = svc.publishListing(publishInput, provider);
    const hire = svc.hire({ listingId: listing.id, buyer });
    fund(svc, hire);
    await svc.flushJobs();
    await svc.flushPayouts();

    expect(svc.getJob(hire.job.jobId)?.receipt?.receipt.outcome).toBe('refund');

    const fresh = new BazaarService({ agent: signingAgent([]), invoke: invoker('ok') });
    fresh.restore(JSON.parse(JSON.stringify(svc.snapshot())));
    const r = fresh.getJob(hire.job.jobId)?.receipt;
    expect(r).toBeDefined();
    expect(verifySignedMessage(canonicalReceipt(r!.receipt), r!.signature, r!.signer)).toBe(true);
  });

  it('mints no receipt when the agent cannot sign', async () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const hire = svc.hire({ listingId: svc.publishListing(publishInput, provider).id, buyer });
    fund(svc, hire);
    await svc.flushJobs();
    svc.acceptJob(hire.job.jobId, buyer);
    await svc.flushPayouts();
    expect(svc.getJob(hire.job.jobId)?.receipt).toBeUndefined();
  });
});

describe('BazaarService - nested escrow (agent sub-hiring)', () => {
  const provider2: Identity = { chainPubkey: `02${'f'.repeat(64)}`, nametag: 'helper' };
  const publishInput2: PublishInput = { ...publishInput, title: 'Sub task', channel: { kind: 'webhook', url: 'https://helper.example.com/hook' } };

  it('links a sub-hired job to its parent, both ways', () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const listingA = svc.publishListing(publishInput, provider);
    const listingB = svc.publishListing(publishInput2, provider2);

    // buyer hires A
    const parent = svc.hire({ listingId: listingA.id, buyer });
    // A (as a buyer now) sub-hires B, tagging the parent job
    const child = svc.hire({ listingId: listingB.id, buyer: provider, parentJobId: parent.job.jobId });

    expect(svc.getJob(child.job.jobId)?.parentJobId).toBe(parent.job.jobId);
    expect(svc.getJob(parent.job.jobId)?.children).toEqual([child.job.jobId]);
  });

  it('ignores an unknown parent and survives snapshot/restore', () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const listingA = svc.publishListing(publishInput, provider);
    const listingB = svc.publishListing(publishInput2, provider2);
    const parent = svc.hire({ listingId: listingA.id, buyer });
    const child = svc.hire({ listingId: listingB.id, buyer: provider, parentJobId: parent.job.jobId });
    // a bogus parent is simply not linked
    const orphan = svc.hire({ listingId: listingB.id, buyer, parentJobId: 'job_does_not_exist' });
    expect(svc.getJob(orphan.job.jobId)?.parentJobId).toBeUndefined();

    const fresh = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    fresh.restore(JSON.parse(JSON.stringify(svc.snapshot())));
    expect(fresh.getJob(child.job.jobId)?.parentJobId).toBe(parent.job.jobId);
    expect(fresh.getJob(parent.job.jobId)?.children).toEqual([child.job.jobId]);
  });
});

describe('BazaarService - persistence', () => {
  it('round-trips full state through snapshot/restore', async () => {
    const svc = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    const listing = svc.publishListing(publishInput, provider);
    const hire = svc.hire({ listingId: listing.id, buyer });
    fund(svc, hire);
    await svc.flushJobs();
    svc.acceptJob(hire.job.jobId, buyer);
    await svc.flushPayouts();
    svc.postReview({ jobId: hire.job.jobId, stars: 5, text: 'top' }, buyer);
    svc.toggleFavorite(listing.id, buyer);

    const snap = JSON.parse(JSON.stringify(svc.snapshot())); // prove it's JSON-safe

    const fresh = new BazaarService({ agent: stubAgent([]), invoke: invoker('ok') });
    fresh.restore(snap);

    expect(fresh.getListings().map((l) => l.id)).toContain(listing.id);
    expect(fresh.getJob(hire.job.jobId)?.job.state).toBe('released');
    expect(fresh.getJob(hire.job.jobId)?.review?.stars).toBe(5);
    expect(fresh.reviewsOf('@scout')).toHaveLength(1);
    expect(fresh.reputationOf('@scout').avgRating).toBe(5);
    expect(fresh.favoriteIdsOf(buyer)).toContain(listing.id);
    expect(fresh.profileOf('@scout').stats.earnedUct).toBe(10);
    // buyer authorization survives restore (jobParties persisted)
    const stranger: Identity = { chainPubkey: `02${'e'.repeat(64)}` };
    expect(fresh.reviewableByBuyer(hire.job.jobId, stranger)).toBe(false);
  });
});
