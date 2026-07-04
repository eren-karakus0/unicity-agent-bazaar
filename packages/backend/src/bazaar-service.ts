import {
  applyEscrowEvent,
  applyOutcome,
  isAutoReleasable,
  makeListing,
  newReputation,
  openEscrow,
  reputationView,
  type EscrowJob,
  type Listing,
  type ListingInput,
  type Reputation,
  type ReputationView,
  type ServiceInvocation,
  type ServiceResult,
} from '@bazaar/core';
import { Logger, createLogger } from './logger.js';
import type { Invoker } from './webhook-client.js';

/** The minimal on-chain surface the service needs — satisfied by SphereAgent. */
export interface BazaarAgent {
  readonly nametag: string;
  readonly uctCoin: { coinId: string; decimals: number };
  send(recipient: string, human: string | number, memo?: string): Promise<unknown>;
  toHuman(smallest: bigint | string): string;
}

export interface BazaarServiceOptions {
  agent: BazaarAgent;
  /** Dispatches a job to the provider agent (webhook / capsule). */
  invoke: Invoker;
  /** How long a delivered job waits before auto-releasing to the provider. */
  autoReleaseMs?: number;
  logger?: Logger;
}

export type SettlementKind = 'release' | 'refund';

export interface Settlement {
  status: 'pending' | 'settled' | 'failed';
  kind: SettlementKind;
  amountUct: number;
  recipient: string;
  txId?: string;
  error?: string;
  at: number;
}

export interface HireResult {
  job: EscrowJob;
  /** Where the buyer sends the UCT (the escrow agent). */
  payTo: string;
  /** The memo the buyer MUST attach so funding matches this escrow. */
  memo: string;
  amountUct: number;
  coinId: string;
  decimals: number;
}

export interface JobView {
  job: EscrowJob;
  result?: ServiceResult;
  settlement?: Settlement;
}

/**
 * The Agent Bazaar platform engine: a registry of listings, an escrow ledger,
 * and the autonomous flow that funds → invokes → delivers → releases/refunds.
 * All state is in-memory (MVP); on-chain moves go through the injected agent.
 */
export class BazaarService {
  private readonly agent: BazaarAgent;
  private readonly invoke: Invoker;
  private readonly autoReleaseMs: number;
  private readonly log: Logger;

  private readonly listings = new Map<string, Listing>();
  private readonly jobs = new Map<string, EscrowJob>();
  private readonly inputs = new Map<string, unknown>();
  private readonly results = new Map<string, ServiceResult>();
  private readonly reputations = new Map<string, Reputation>();
  private readonly settlements = new Map<string, Settlement>();
  /** escrowRef -> jobId, for matching an incoming funding memo to its job. */
  private readonly escrowIndex = new Map<string, string>();
  private readonly seenFunding = new Set<string>();

  // Settlement is serialized so escrow payouts can't race on coin selection.
  private payLock: Promise<void> = Promise.resolve();
  private readonly inFlightPayouts = new Set<Promise<void>>();
  private readonly inFlightJobs = new Set<Promise<void>>();

  constructor(opts: BazaarServiceOptions) {
    this.agent = opts.agent;
    this.invoke = opts.invoke;
    this.autoReleaseMs = opts.autoReleaseMs ?? 2 * 60_000;
    this.log = opts.logger ?? createLogger('bazaar');
  }

  // ---- registry ----

  publishListing(input: ListingInput): Listing {
    const listing = makeListing(input); // validates; throws on bad input
    this.listings.set(listing.id, listing);
    if (!this.reputations.has(listing.agentNametag)) {
      this.reputations.set(listing.agentNametag, newReputation(listing.agentNametag));
    }
    this.log.info(`listing published: ${listing.slug} — ${listing.priceUct} UCT`);
    return listing;
  }

  getListings(): Listing[] {
    return [...this.listings.values()].filter((l) => l.active).sort((a, b) => b.createdAt - a.createdAt);
  }
  getListing(id: string): Listing | undefined {
    return this.listings.get(id);
  }

  // ---- hire + funding ----

  /** Open an escrow for a listing and return the buyer's payment instructions. */
  hire(input: { listingId: string; buyerNametag: string; input?: unknown }): HireResult {
    const listing = this.listings.get(input.listingId);
    if (!listing || !listing.active) throw new Error('unknown or inactive listing');
    const buyer = `@${(input.buyerNametag ?? '').trim().replace(/^@/, '')}`;
    if (buyer.length < 3) throw new Error('a buyerNametag is required');
    const job = openEscrow({
      listingId: listing.id,
      buyerNametag: buyer,
      providerNametag: listing.agentNametag,
      amountUct: listing.priceUct,
    });
    this.jobs.set(job.jobId, job);
    this.escrowIndex.set(job.escrowRef, job.jobId);
    if (input.input !== undefined) this.inputs.set(job.jobId, input.input);
    this.log.info(`hired ${listing.slug}: job ${job.jobId} quoted at ${job.amountUct} UCT`);
    return {
      job,
      payTo: `@${this.agent.nametag}`,
      memo: job.escrowRef,
      amountUct: job.amountUct,
      coinId: this.agent.uctCoin.coinId,
      decimals: this.agent.uctCoin.decimals,
    };
  }

  /**
   * Credit an incoming escrow funding, matched to a job by its memo (escrowRef).
   * Idempotent per dedupKey. On funding, the provider is invoked in the
   * background. Returns the funded job, or null if nothing matched.
   */
  creditFunding(t: { dedupKey: string; amountBase: string; memo?: string }): EscrowJob | null {
    if (!t.dedupKey || this.seenFunding.has(t.dedupKey)) return null;
    const memo = (t.memo ?? '').trim();
    if (!memo) return null;
    const jobId = this.escrowIndex.get(memo);
    if (!jobId) return null; // no matching job (yet) — leave unseen so a later sweep can retry
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'quoted') return null;

    let amount: number;
    try {
      amount = Math.floor(Number(this.agent.toHuman(t.amountBase)));
    } catch {
      return null;
    }
    if (amount < job.amountUct) return null; // underfunded — ignore until fully funded

    this.seenFunding.add(t.dedupKey);
    const funded = applyEscrowEvent(job, 'fund');
    this.jobs.set(jobId, funded);
    this.log.info(`escrow ${job.escrowRef} funded with ${amount} UCT — invoking provider`);
    void this.runJob(funded);
    return funded;
  }

  // ---- provider invocation ----

  private runJob(job: EscrowJob): Promise<void> {
    const run = (async () => {
      const listing = this.listings.get(job.listingId);
      if (!listing) {
        this.refundJob(job, 'listing no longer exists');
        return;
      }
      const invocation: ServiceInvocation = {
        jobId: job.jobId,
        listingId: job.listingId,
        buyerNametag: job.buyerNametag,
        input: this.inputs.get(job.jobId),
        amountUct: job.amountUct,
        escrowRef: job.escrowRef,
      };
      let result: ServiceResult;
      try {
        result = await this.invoke(listing.channel, invocation);
      } catch (e) {
        result = { jobId: job.jobId, ok: false, error: e instanceof Error ? e.message : 'invocation error' };
      }
      const current = this.jobs.get(job.jobId);
      if (!current || current.state !== 'funded') return; // state moved on; nothing to do
      if (result.ok) {
        const delivered = applyEscrowEvent(current, 'deliver');
        this.jobs.set(job.jobId, delivered);
        this.results.set(job.jobId, result);
        this.log.info(`job ${job.jobId} delivered by ${job.providerNametag}`);
      } else {
        this.results.set(job.jobId, result);
        this.refundJob(current, result.error ?? 'provider failed');
      }
    })();
    this.inFlightJobs.add(run);
    void run.finally(() => this.inFlightJobs.delete(run));
    return run;
  }

  // ---- resolution ----

  /** Buyer accepts a delivered job → release funds to the provider. */
  acceptJob(jobId: string): EscrowJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('unknown job');
    const released = applyEscrowEvent(job, 'accept'); // throws unless delivered
    this.jobs.set(jobId, released);
    this.enqueueSettlement(released, released.providerNametag, 'release');
    return released;
  }

  /** Buyer disputes a delivered job → hold, pending resolution. */
  disputeJob(jobId: string): EscrowJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('unknown job');
    const disputed = applyEscrowEvent(job, 'dispute');
    this.jobs.set(jobId, disputed);
    this.log.warn(`job ${jobId} disputed by ${disputed.buyerNametag}`);
    return disputed;
  }

  /** Resolve a dispute either way (operator action; auth deferred to a later phase). */
  resolveDispute(jobId: string, outcome: SettlementKind): EscrowJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('unknown job');
    const resolved = applyEscrowEvent(job, outcome === 'release' ? 'resolve_release' : 'resolve_refund');
    this.jobs.set(jobId, resolved);
    const recipient = outcome === 'release' ? resolved.providerNametag : resolved.buyerNametag;
    this.enqueueSettlement(resolved, recipient, outcome);
    return resolved;
  }

  private refundJob(job: EscrowJob, reason: string): void {
    const refunded = applyEscrowEvent(job, 'refund');
    this.jobs.set(job.jobId, refunded);
    this.log.warn(`job ${job.jobId} refunded: ${reason}`);
    this.enqueueSettlement(refunded, refunded.buyerNametag, 'refund');
  }

  /** Release any delivered jobs whose acceptance window has elapsed. */
  sweepAutoRelease(now = Date.now()): void {
    for (const job of this.jobs.values()) {
      if (isAutoReleasable(job, this.autoReleaseMs, now)) {
        try {
          this.acceptJob(job.jobId);
          this.log.info(`job ${job.jobId} auto-released after the acceptance window`);
        } catch (e) {
          this.log.warn(`auto-release failed for ${job.jobId}`, e instanceof Error ? e.message : e);
        }
      }
    }
  }

  // ---- settlement (serialized on-chain payout) ----

  private enqueueSettlement(job: EscrowJob, recipient: string, kind: SettlementKind): void {
    const memo = kind === 'release' ? 'bazaar-release' : 'bazaar-refund';
    this.settlements.set(job.jobId, { status: 'pending', kind, amountUct: job.amountUct, recipient, at: Date.now() });
    const run = this.payLock.then(async () => {
      try {
        const tx = (await this.agent.send(recipient, job.amountUct, memo)) as { id?: string };
        this.settlements.set(job.jobId, {
          status: 'settled',
          kind,
          amountUct: job.amountUct,
          recipient,
          txId: tx?.id,
          at: Date.now(),
        });
        // Reputation is the provider's: a release is a completed job, a refund a failed one.
        const rep = this.repOf(job.providerNametag);
        this.reputations.set(
          job.providerNametag,
          applyOutcome(rep, kind === 'release' ? 'released' : 'refunded', job.amountUct),
        );
        this.log.info(`${kind} settled: ${job.amountUct} UCT → ${recipient}`);
      } catch (e) {
        this.settlements.set(job.jobId, {
          status: 'failed',
          kind,
          amountUct: job.amountUct,
          recipient,
          error: e instanceof Error ? e.message : 'send failed',
          at: Date.now(),
        });
        this.log.warn(`${kind} settlement failed for ${job.jobId}`);
      }
    });
    this.payLock = run.catch(() => {});
    this.inFlightPayouts.add(run);
    void run.finally(() => this.inFlightPayouts.delete(run));
  }

  // ---- views ----

  getJob(jobId: string): JobView | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    return {
      job,
      ...(this.results.has(jobId) ? { result: this.results.get(jobId) } : {}),
      ...(this.settlements.has(jobId) ? { settlement: this.settlements.get(jobId) } : {}),
    };
  }

  reputationOf(nametag: string): ReputationView {
    const key = `@${nametag.trim().replace(/^@/, '')}`;
    return reputationView(this.reputations.get(key) ?? newReputation(key));
  }

  private repOf(nametag: string): Reputation {
    return this.reputations.get(nametag) ?? newReputation(nametag);
  }

  // ---- test/loop helpers ----

  /** Await all in-flight provider invocations. */
  async flushJobs(): Promise<void> {
    while (this.inFlightJobs.size > 0) {
      await Promise.all([...this.inFlightJobs]);
    }
  }

  /** Await all in-flight settlements. */
  async flushPayouts(): Promise<void> {
    while (this.inFlightPayouts.size > 0) {
      await Promise.all([...this.inFlightPayouts]);
    }
  }
}
