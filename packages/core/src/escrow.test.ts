import { describe, expect, it } from 'vitest';
import {
  applyEscrowEvent,
  isAutoReleasable,
  isTerminal,
  nextState,
  openEscrow,
  type EscrowJob,
} from './escrow.js';

const base = () =>
  openEscrow({ listingId: 'l1', buyerNametag: '@buyer', providerNametag: '@seller', amountUct: 10, now: 1000 });

describe('escrow — opening', () => {
  it('opens in the quoted state with a job id and escrow ref', () => {
    const job = base();
    expect(job.state).toBe('quoted');
    expect(job.jobId).toMatch(/^job_/);
    expect(job.escrowRef).toMatch(/^esc_/);
    expect(job.amountUct).toBe(10);
  });

  it('rejects non-positive or non-integer amounts', () => {
    expect(() => openEscrow({ listingId: 'l', buyerNametag: '@b', providerNametag: '@s', amountUct: 0 })).toThrow();
    expect(() => openEscrow({ listingId: 'l', buyerNametag: '@b', providerNametag: '@s', amountUct: -5 })).toThrow();
    expect(() => openEscrow({ listingId: 'l', buyerNametag: '@b', providerNametag: '@s', amountUct: 1.5 })).toThrow();
  });
});

describe('escrow — state machine', () => {
  it('walks the happy path quoted → funded → delivered → released', () => {
    let job = base();
    job = applyEscrowEvent(job, 'fund', 2000);
    expect(job.state).toBe('funded');
    job = applyEscrowEvent(job, 'deliver', 3000);
    expect(job.state).toBe('delivered');
    expect(job.deliveredAt).toBe(3000);
    job = applyEscrowEvent(job, 'accept', 4000);
    expect(job.state).toBe('released');
    expect(isTerminal(job.state)).toBe(true);
  });

  it('refunds an unfunded cancel and a funded-but-undelivered refund', () => {
    expect(applyEscrowEvent(base(), 'cancel').state).toBe('cancelled');
    const funded = applyEscrowEvent(base(), 'fund');
    expect(applyEscrowEvent(funded, 'refund').state).toBe('refunded');
  });

  it('resolves a dispute either way', () => {
    let job = applyEscrowEvent(applyEscrowEvent(base(), 'fund'), 'deliver');
    job = applyEscrowEvent(job, 'dispute');
    expect(job.state).toBe('disputed');
    expect(applyEscrowEvent(job, 'resolve_release').state).toBe('released');
    expect(applyEscrowEvent(job, 'resolve_refund').state).toBe('refunded');
  });

  it('throws on illegal transitions', () => {
    const job = base(); // quoted
    expect(() => applyEscrowEvent(job, 'deliver')).toThrow(/illegal/);
    expect(() => applyEscrowEvent(job, 'accept')).toThrow(/illegal/);
    // A terminal job rejects any further event.
    const released = applyEscrowEvent(applyEscrowEvent(applyEscrowEvent(job, 'fund'), 'deliver'), 'accept');
    expect(released.state).toBe('released');
    expect(() => applyEscrowEvent(released, 'accept')).toThrow(/illegal/);
  });

  it('has no outgoing transitions from terminal states', () => {
    expect(nextState('released', 'accept')).toBeUndefined();
    expect(nextState('refunded', 'fund')).toBeUndefined();
    expect(nextState('cancelled', 'fund')).toBeUndefined();
  });
});

describe('escrow — auto-release window', () => {
  const delivered: EscrowJob = applyEscrowEvent(applyEscrowEvent(base(), 'fund', 2000), 'deliver', 3000);

  it('is not releasable before the window elapses', () => {
    expect(isAutoReleasable(delivered, 60_000, 3000 + 59_000)).toBe(false);
  });

  it('is releasable once the window elapses', () => {
    expect(isAutoReleasable(delivered, 60_000, 3000 + 60_000)).toBe(true);
  });

  it('is never auto-releasable outside the delivered state', () => {
    const funded = applyEscrowEvent(base(), 'fund', 2000);
    expect(isAutoReleasable(funded, 0, 9_000_000)).toBe(false);
  });
});
