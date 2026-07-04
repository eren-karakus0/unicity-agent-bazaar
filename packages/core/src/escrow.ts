import { newEscrowRef, newJobId } from './ids.js';

/** Lifecycle of an escrowed job. Terminal: released, refunded, cancelled. */
export type EscrowState =
  | 'quoted' // hired; awaiting the buyer to fund
  | 'funded' // the buyer's UCT is held by the escrow agent
  | 'delivered' // provider delivered; awaiting acceptance / auto-release
  | 'released' // funds paid to the provider (success)
  | 'refunded' // funds returned to the buyer
  | 'disputed' // buyer disputed within the window
  | 'cancelled'; // cancelled before funding

export type EscrowEvent =
  | 'fund'
  | 'deliver'
  | 'accept'
  | 'dispute'
  | 'resolve_release'
  | 'resolve_refund'
  | 'refund'
  | 'cancel';

export interface EscrowJob {
  jobId: string;
  escrowRef: string;
  listingId: string;
  buyerNametag: string;
  providerNametag: string;
  amountUct: number;
  state: EscrowState;
  createdAt: number;
  updatedAt: number;
  /** Set when delivered; drives the auto-release window. */
  deliveredAt?: number;
}

/** The legal transition table: from-state → event → to-state. */
const TRANSITIONS: Record<EscrowState, Partial<Record<EscrowEvent, EscrowState>>> = {
  quoted: { fund: 'funded', cancel: 'cancelled' },
  funded: { deliver: 'delivered', refund: 'refunded' },
  delivered: { accept: 'released', dispute: 'disputed', refund: 'refunded' },
  disputed: { resolve_release: 'released', resolve_refund: 'refunded' },
  released: {},
  refunded: {},
  cancelled: {},
};

export const TERMINAL_STATES: readonly EscrowState[] = ['released', 'refunded', 'cancelled'];

export function isTerminal(state: EscrowState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** The state an event would move to, or undefined if the transition is illegal. */
export function nextState(state: EscrowState, event: EscrowEvent): EscrowState | undefined {
  return TRANSITIONS[state][event];
}

export interface NewEscrowInput {
  listingId: string;
  buyerNametag: string;
  providerNametag: string;
  amountUct: number;
  now?: number;
}

/** Open a fresh escrow in the `quoted` state. */
export function openEscrow(input: NewEscrowInput): EscrowJob {
  if (!Number.isInteger(input.amountUct) || input.amountUct <= 0) {
    throw new Error('escrow amount must be a positive integer of UCT');
  }
  const now = input.now ?? Date.now();
  return {
    jobId: newJobId(),
    escrowRef: newEscrowRef(),
    listingId: input.listingId,
    buyerNametag: input.buyerNametag,
    providerNametag: input.providerNametag,
    amountUct: input.amountUct,
    state: 'quoted',
    createdAt: now,
    updatedAt: now,
  };
}

/** Apply an event, returning a new job. Throws on an illegal transition. */
export function applyEscrowEvent(job: EscrowJob, event: EscrowEvent, now = Date.now()): EscrowJob {
  const to = nextState(job.state, event);
  if (!to) {
    throw new Error(`illegal escrow transition: ${job.state} --${event}-->`);
  }
  return {
    ...job,
    state: to,
    updatedAt: now,
    ...(event === 'deliver' ? { deliveredAt: now } : {}),
  };
}

/**
 * Whether a delivered job is past its auto-release window and can be released to
 * the provider without explicit buyer acceptance — so an absent buyer can never
 * strand a provider's payment.
 */
export function isAutoReleasable(job: EscrowJob, windowMs: number, now = Date.now()): boolean {
  return (
    job.state === 'delivered' && job.deliveredAt !== undefined && now - job.deliveredAt >= windowMs
  );
}
