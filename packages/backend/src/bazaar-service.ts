import {
  applyEscrowEvent,
  applyOutcome,
  applyRating,
  clampStars,
  earnedAchievements,
  hotScore,
  isAutoReleasable,
  makeListing,
  newReputation,
  openEscrow,
  reputationView,
  validateReview,
  type Achievement,
  type EscrowJob,
  type EscrowState,
  type Listing,
  type ListingInput,
  type Reputation,
  type ReputationView,
  type Review,
  type ServiceInvocation,
  type ServiceResult,
} from '@bazaar/core';
import crypto from 'node:crypto';
import { principalOf, type Identity } from './auth.js';
import { Logger, createLogger } from './logger.js';
import type { Invoker } from './webhook-client.js';

/** A publish request from an authenticated provider — the server assigns the owner. */
export type PublishInput = Omit<ListingInput, 'agentNametag'>;

/** A compact job row for profile pages. */
export interface JobSummary {
  jobId: string;
  listingId: string;
  listingTitle?: string;
  amountUct: number;
  state: EscrowState;
  role: 'buyer' | 'provider';
  /** The other party's principal (@nametag or pubkey). */
  counterparty: string;
  createdAt: number;
  updatedAt: number;
}

/** A listing plus the platform metadata the marketplace renders. */
export type DecoratedListing = Listing & {
  favorites: number;
  hot: number;
  avgRating: number | null;
  ratingCount: number;
  jobsCompleted: number;
  successRate: number;
};

/** Aggregated public view of one principal's activity on the bazaar. */
export interface ProfileView {
  principal: string;
  nametag?: string;
  chainPubkey?: string;
  reputation: ReputationView;
  listings: DecoratedListing[];
  asProvider: JobSummary[];
  asBuyer: JobSummary[];
  reviews: Review[];
  achievements: Achievement[];
  stats: {
    listingsActive: number;
    jobsAsProvider: number;
    jobsAsBuyer: number;
    earnedUct: number;
    spentUct: number;
    favoritesReceived: number;
  };
}

/** Normalize an identifier to a principal key: a pubkey stays hex, else `@nametag`. */
export function toPrincipal(s: string): string {
  const t = (s ?? '').trim();
  if (/^0[23][0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  return `@${t.replace(/^@/, '')}`;
}

/** A serializable snapshot of the whole marketplace state (for file persistence). */
export interface BazaarSnapshot {
  v: 1;
  listings: [string, Listing][];
  jobs: [string, EscrowJob][];
  inputs: [string, unknown][];
  results: [string, ServiceResult][];
  settlements: [string, Settlement][];
  reputations: [string, Reputation][];
  listingProviders: [string, Identity][];
  jobParties: [string, { buyer: Identity; provider: Identity }][];
  escrowIndex: [string, string][];
  seenFunding: string[];
  reviews: [string, Review][];
  reviewsByProvider: [string, string[]][];
  favorites: [string, string[]][];
  favoriteCounts: [string, number][];
  webhookSecrets: [string, string][];
}

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
  review?: Review;
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
  /** listingId -> the authenticated provider who published it. */
  private readonly listingProviders = new Map<string, Identity>();
  /** jobId -> the proven identities on both sides (drives spoof-proof payout). */
  private readonly jobParties = new Map<string, { buyer: Identity; provider: Identity }>();
  /** escrowRef -> jobId, for matching an incoming funding memo to its job. */
  private readonly escrowIndex = new Map<string, string>();
  private readonly seenFunding = new Set<string>();
  /** jobId -> verified-purchase review (one per job). */
  private readonly reviews = new Map<string, Review>();
  /** provider principal -> jobIds they've been reviewed on (newest last). */
  private readonly reviewsByProvider = new Map<string, string[]>();
  /** principal -> the set of listingIds they've favorited. */
  private readonly favorites = new Map<string, Set<string>>();
  /** listingId -> favorite count (denormalized for cheap reads). */
  private readonly favoriteCounts = new Map<string, number>();
  /** listingId -> the HMAC secret we sign that listing's job POSTs with. */
  private readonly webhookSecrets = new Map<string, string>();

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

  /** Publish a listing owned by an authenticated provider (its @nametag = the owner's). */
  publishListing(input: PublishInput, owner: Identity): Listing {
    if (!owner.nametag) {
      throw new Error('register a @nametag in your Sphere wallet before publishing a listing');
    }
    const agentNametag = principalOf(owner);
    const listing = makeListing({ ...input, agentNametag }); // validates; throws on bad input
    this.listings.set(listing.id, listing);
    this.listingProviders.set(listing.id, owner);
    if (listing.channel.kind === 'webhook') {
      this.webhookSecrets.set(listing.id, crypto.randomBytes(24).toString('hex'));
    }
    if (!this.reputations.has(agentNametag)) {
      this.reputations.set(agentNametag, newReputation(agentNametag));
    }
    this.log.info(`listing published: ${listing.slug} — ${listing.priceUct} UCT by ${agentNametag}`);
    return listing;
  }

  /** The webhook signing secret for a listing (surfaced ONCE in the publish response). */
  webhookSecretFor(listingId: string): string | undefined {
    return this.webhookSecrets.get(listingId);
  }

  getListings(): Listing[] {
    return [...this.listings.values()].filter((l) => l.active).sort((a, b) => b.createdAt - a.createdAt);
  }
  getListing(id: string): Listing | undefined {
    return this.listings.get(id);
  }
  listingOwner(id: string): Identity | undefined {
    return this.listingProviders.get(id);
  }

  // ---- hire + funding ----

  /** Open an escrow for a listing and return the buyer's payment instructions. */
  hire(input: { listingId: string; buyer: Identity; input?: unknown }): HireResult {
    const listing = this.listings.get(input.listingId);
    if (!listing || !listing.active) throw new Error('unknown or inactive listing');
    const buyerPrincipal = principalOf(input.buyer);
    const provider = this.listingProviders.get(listing.id) ?? {
      chainPubkey: '',
      nametag: listing.agentNametag.replace(/^@/, ''),
    };
    if (provider.chainPubkey && provider.chainPubkey === input.buyer.chainPubkey) {
      throw new Error('you cannot hire your own listing');
    }
    const job = openEscrow({
      listingId: listing.id,
      buyerNametag: buyerPrincipal,
      providerNametag: listing.agentNametag,
      amountUct: listing.priceUct,
    });
    this.jobs.set(job.jobId, job);
    this.jobParties.set(job.jobId, { buyer: input.buyer, provider });
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
        result = await this.invoke(listing.channel, invocation, this.webhookSecrets.get(listing.id));
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
  acceptJob(jobId: string, caller: Identity): EscrowJob {
    const job = this.requireJob(jobId);
    this.assertBuyer(job, caller);
    return this.release(job);
  }

  /** Buyer disputes a delivered job → hold, pending resolution. */
  disputeJob(jobId: string, caller: Identity): EscrowJob {
    const job = this.requireJob(jobId);
    this.assertBuyer(job, caller);
    const disputed = applyEscrowEvent(job, 'dispute');
    this.jobs.set(jobId, disputed);
    this.log.warn(`job ${jobId} disputed by ${disputed.buyerNametag}`);
    return disputed;
  }

  /** Resolve a dispute either way (operator action — gated at the transport). */
  resolveDispute(jobId: string, outcome: SettlementKind): EscrowJob {
    const job = this.requireJob(jobId);
    const resolved = applyEscrowEvent(job, outcome === 'release' ? 'resolve_release' : 'resolve_refund');
    this.jobs.set(jobId, resolved);
    this.enqueueSettlement(resolved, outcome);
    return resolved;
  }

  /** Move a delivered job to released and pay the provider. */
  private release(job: EscrowJob): EscrowJob {
    const released = applyEscrowEvent(job, 'accept'); // throws unless delivered
    this.jobs.set(job.jobId, released);
    this.enqueueSettlement(released, 'release');
    return released;
  }

  private refundJob(job: EscrowJob, reason: string): void {
    const refunded = applyEscrowEvent(job, 'refund');
    this.jobs.set(job.jobId, refunded);
    this.log.warn(`job ${job.jobId} refunded: ${reason}`);
    this.enqueueSettlement(refunded, 'refund');
  }

  private requireJob(jobId: string): EscrowJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('unknown job');
    return job;
  }

  /** Only the job's proven buyer may accept or dispute it. */
  private assertBuyer(job: EscrowJob, caller: Identity): void {
    const buyer = this.jobParties.get(job.jobId)?.buyer;
    if (buyer?.chainPubkey && caller.chainPubkey !== buyer.chainPubkey) {
      throw new Error('only the buyer can act on this job');
    }
  }

  /** Route a payout to the counterparty's PROVEN wallet key (nametag-spoof-proof). */
  private settlementRecipient(job: EscrowJob, kind: SettlementKind): string {
    const parties = this.jobParties.get(job.jobId);
    const party = kind === 'release' ? parties?.provider : parties?.buyer;
    const pk = party?.chainPubkey?.trim();
    if (pk) return pk;
    return kind === 'release' ? job.providerNametag : job.buyerNametag;
  }

  /** Release any delivered jobs whose acceptance window has elapsed. */
  sweepAutoRelease(now = Date.now()): void {
    for (const job of this.jobs.values()) {
      if (isAutoReleasable(job, this.autoReleaseMs, now)) {
        try {
          this.release(job);
          this.log.info(`job ${job.jobId} auto-released after the acceptance window`);
        } catch (e) {
          this.log.warn(`auto-release failed for ${job.jobId}`, e instanceof Error ? e.message : e);
        }
      }
    }
  }

  // ---- settlement (serialized on-chain payout) ----

  private enqueueSettlement(job: EscrowJob, kind: SettlementKind): void {
    const recipient = this.settlementRecipient(job, kind);
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
      ...(this.reviews.has(jobId) ? { review: this.reviews.get(jobId) } : {}),
    };
  }

  reputationOf(nametag: string): ReputationView {
    const key = toPrincipal(nametag);
    return reputationView(this.reputations.get(key) ?? newReputation(key));
  }

  /** Everything a profile page needs about one principal (@nametag or pubkey). */
  profileOf(principal: string): ProfileView {
    const key = toPrincipal(principal);
    const listings = [...this.listings.values()]
      .filter((l) => l.active && l.agentNametag === key)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((l) => this.decorateListing(l));

    const asProvider: JobSummary[] = [];
    const asBuyer: JobSummary[] = [];
    for (const job of this.jobs.values()) {
      if (job.providerNametag === key) asProvider.push(this.summarize(job, 'provider'));
      if (job.buyerNametag === key) asBuyer.push(this.summarize(job, 'buyer'));
    }
    asProvider.sort((a, b) => b.updatedAt - a.updatedAt);
    asBuyer.sort((a, b) => b.updatedAt - a.updatedAt);

    const reputation = this.reputationOf(key);
    const rep = this.reputations.get(key);
    const spentUct = asBuyer.filter((j) => j.state === 'released').reduce((s, j) => s + j.amountUct, 0);
    const chainPubkey = this.pubkeyOf(key); // best-effort, once they've published or traded
    const favoritesReceived = listings.reduce((s, l) => s + l.favorites, 0);
    const distinctProvidersBought = new Set(
      asBuyer.filter((j) => j.state === 'released').map((j) => j.counterparty),
    ).size;

    const achievements = earnedAchievements({
      listingsPublished: listings.length,
      jobsSoldReleased: reputation.jobsCompleted,
      jobsSoldRefunded: rep?.jobsRefunded ?? 0,
      earnedUct: reputation.volumeUct,
      avgRating: reputation.avgRating,
      ratingCount: rep?.ratingCount ?? 0,
      jobsBoughtReleased: asBuyer.filter((j) => j.state === 'released').length,
      spentUct,
      distinctProvidersBought,
    });

    return {
      principal: key,
      ...(key.startsWith('@') ? { nametag: key.slice(1) } : {}),
      ...(chainPubkey ? { chainPubkey } : {}),
      reputation,
      listings,
      asProvider,
      asBuyer,
      reviews: this.reviewsOf(key),
      achievements,
      stats: {
        listingsActive: listings.length,
        jobsAsProvider: asProvider.length,
        jobsAsBuyer: asBuyer.length,
        earnedUct: reputation.volumeUct,
        spentUct,
        favoritesReceived,
      },
    };
  }

  /** Best-effort proven chain pubkey for a principal, from listings or job parties. */
  private pubkeyOf(principal: string): string | undefined {
    for (const owner of this.listingProviders.values()) {
      if (principalOf(owner) === principal) return owner.chainPubkey;
    }
    for (const { buyer, provider } of this.jobParties.values()) {
      if (principalOf(provider) === principal) return provider.chainPubkey;
      if (principalOf(buyer) === principal) return buyer.chainPubkey;
    }
    return undefined;
  }

  private summarize(job: EscrowJob, role: 'buyer' | 'provider'): JobSummary {
    const listing = this.listings.get(job.listingId);
    return {
      jobId: job.jobId,
      listingId: job.listingId,
      ...(listing ? { listingTitle: listing.title } : {}),
      amountUct: job.amountUct,
      state: job.state,
      role,
      counterparty: role === 'provider' ? job.buyerNametag : job.providerNametag,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  // ---- social: listings meta, trending, favorites, reviews ----

  /** Attach favorites + a time-decayed "hot" score + rating to a listing. */
  decorateListing(listing: Listing): DecoratedListing {
    const favorites = this.favoriteCounts.get(listing.id) ?? 0;
    const rep = this.reputations.get(listing.agentNametag);
    const view = reputationView(rep ?? newReputation(listing.agentNametag));
    const hot = hotScore({
      jobActivityAt: this.jobActivityFor(listing.id),
      favorites,
      avgRating: view.avgRating,
      ratingCount: rep?.ratingCount ?? 0,
    });
    return {
      ...listing,
      favorites,
      hot,
      avgRating: view.avgRating,
      ratingCount: rep?.ratingCount ?? 0,
      jobsCompleted: view.jobsCompleted,
      successRate: view.successRate,
    };
  }

  /** Active listings, decorated, newest first. */
  listingsDecorated(): DecoratedListing[] {
    return this.getListings().map((l) => this.decorateListing(l));
  }

  /** The hottest active listings (highest hot score first). */
  trending(limit = 4): DecoratedListing[] {
    return this.listingsDecorated()
      .sort((a, b) => b.hot - a.hot || b.createdAt - a.createdAt)
      .slice(0, limit)
      .filter((l) => l.hot > 0 || l.favorites > 0);
  }

  /** `updatedAt` of each job for a listing that saw real economic activity (funded+). */
  private jobActivityFor(listingId: string): number[] {
    const out: number[] = [];
    for (const job of this.jobs.values()) {
      if (job.listingId === listingId && job.state !== 'quoted' && job.state !== 'cancelled') {
        out.push(job.updatedAt);
      }
    }
    return out;
  }

  /** Toggle a caller's favorite on a listing. Returns the new state + count. */
  toggleFavorite(listingId: string, caller: Identity): { favorited: boolean; favorites: number } {
    if (!this.listings.has(listingId)) throw new Error('unknown listing');
    const principal = principalOf(caller);
    const set = this.favorites.get(principal) ?? new Set<string>();
    let favorited: boolean;
    if (set.has(listingId)) {
      set.delete(listingId);
      favorited = false;
    } else {
      set.add(listingId);
      favorited = true;
    }
    this.favorites.set(principal, set);
    const count = Math.max(0, (this.favoriteCounts.get(listingId) ?? 0) + (favorited ? 1 : -1));
    this.favoriteCounts.set(listingId, count);
    return { favorited, favorites: count };
  }

  /** The listingIds a principal has favorited (for the client to mark stars). */
  favoriteIdsOf(caller: Identity): string[] {
    return [...(this.favorites.get(principalOf(caller)) ?? [])];
  }

  /** The active listings a principal has favorited, decorated. */
  favoritesDecorated(caller: Identity): DecoratedListing[] {
    const ids = this.favorites.get(principalOf(caller)) ?? new Set<string>();
    return [...ids]
      .map((id) => this.listings.get(id))
      .filter((l): l is Listing => !!l && l.active)
      .map((l) => this.decorateListing(l));
  }

  /**
   * Record a verified-purchase review. Only the buyer of a RELEASED job may
   * review it, and only once. The star rating folds into the provider's
   * reputation.
   */
  postReview(input: { jobId: string; stars: number; text?: string }, caller: Identity): Review {
    const job = this.requireJob(input.jobId);
    this.assertBuyer(job, caller);
    if (job.state !== 'released') throw new Error('you can only review a completed (released) job');
    if (this.reviews.has(job.jobId)) throw new Error('this job has already been reviewed');
    const text = (input.text ?? '').trim();
    const check = validateReview(input.stars, text);
    if (!check.ok) throw new Error(check.errors.join('; '));

    const review: Review = {
      jobId: job.jobId,
      listingId: job.listingId,
      providerNametag: job.providerNametag,
      buyerNametag: job.buyerNametag,
      stars: clampStars(input.stars),
      text,
      createdAt: Date.now(),
    };
    this.reviews.set(job.jobId, review);
    const list = this.reviewsByProvider.get(job.providerNametag) ?? [];
    list.push(job.jobId);
    this.reviewsByProvider.set(job.providerNametag, list);
    this.reputations.set(job.providerNametag, applyRating(this.repOf(job.providerNametag), review.stars));
    this.log.info(`review posted: ${review.stars}★ for ${job.providerNametag} (job ${job.jobId})`);
    return review;
  }

  /** Whether a job can still be reviewed by its buyer (released + not yet reviewed). */
  reviewableByBuyer(jobId: string, caller: Identity): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'released' || this.reviews.has(jobId)) return false;
    const buyer = this.jobParties.get(jobId)?.buyer;
    return !buyer?.chainPubkey || buyer.chainPubkey === caller.chainPubkey;
  }

  /** Marketplace-wide activity totals for the hero / dashboards. */
  platformStats(): {
    providers: number;
    listings: number;
    jobsSettled: number;
    uctSettled: number;
    reviews: number;
  } {
    const listings = this.getListings();
    const providers = new Set(listings.map((l) => l.agentNametag)).size;
    let jobsSettled = 0;
    let uctSettled = 0;
    for (const job of this.jobs.values()) {
      if (job.state === 'released') {
        jobsSettled += 1;
        uctSettled += job.amountUct;
      }
    }
    return { providers, listings: listings.length, jobsSettled, uctSettled, reviews: this.reviews.size };
  }

  /** Reviews received by a provider principal, newest first. */
  reviewsOf(principal: string): Review[] {
    const key = toPrincipal(principal);
    const ids = this.reviewsByProvider.get(key) ?? [];
    return ids
      .map((id) => this.reviews.get(id))
      .filter((r): r is Review => !!r)
      .sort((a, b) => b.createdAt - a.createdAt);
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

  // ---- persistence ----

  /** A plain, JSON-serializable snapshot of all in-memory state. */
  snapshot(): BazaarSnapshot {
    return {
      v: 1,
      listings: [...this.listings],
      jobs: [...this.jobs],
      inputs: [...this.inputs],
      results: [...this.results],
      settlements: [...this.settlements],
      reputations: [...this.reputations],
      listingProviders: [...this.listingProviders],
      jobParties: [...this.jobParties],
      escrowIndex: [...this.escrowIndex],
      seenFunding: [...this.seenFunding],
      reviews: [...this.reviews],
      reviewsByProvider: [...this.reviewsByProvider],
      favorites: [...this.favorites].map(([k, set]) => [k, [...set]] as [string, string[]]),
      favoriteCounts: [...this.favoriteCounts],
      webhookSecrets: [...this.webhookSecrets],
    };
  }

  /** Rehydrate state from a snapshot (replaces current state). */
  restore(snap: BazaarSnapshot): void {
    if (!snap || snap.v !== 1) return;
    const fill = <K, V>(map: Map<K, V>, entries: [K, V][]) => {
      map.clear();
      for (const [k, v] of entries) map.set(k, v);
    };
    fill(this.listings, snap.listings);
    fill(this.jobs, snap.jobs);
    fill(this.inputs, snap.inputs);
    fill(this.results, snap.results);
    fill(this.settlements, snap.settlements);
    fill(this.reputations, snap.reputations);
    fill(this.listingProviders, snap.listingProviders);
    fill(this.jobParties, snap.jobParties);
    fill(this.escrowIndex, snap.escrowIndex);
    fill(this.reviews, snap.reviews);
    fill(this.reviewsByProvider, snap.reviewsByProvider);
    fill(this.favoriteCounts, snap.favoriteCounts);
    fill(this.webhookSecrets, snap.webhookSecrets ?? []);
    this.seenFunding.clear();
    for (const k of snap.seenFunding) this.seenFunding.add(k);
    this.favorites.clear();
    for (const [k, ids] of snap.favorites) this.favorites.set(k, new Set(ids));
  }
}
