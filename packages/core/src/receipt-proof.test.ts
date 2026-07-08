import { describe, expect, it } from 'vitest';
import { canonicalReceipt, type SettlementReceipt } from './receipt-proof.js';

const base: SettlementReceipt = {
  v: 1,
  jobId: 'job_1',
  listingId: 'listing_1',
  escrowRef: 'esc_1',
  buyer: '@buyer',
  provider: '@scout',
  amountUct: 10,
  outcome: 'release',
  recipient: `02${'a'.repeat(64)}`,
  txId: 'tx_1',
  settledAt: 1_700_000_000_000,
};

describe('canonicalReceipt', () => {
  it('is independent of object key order', () => {
    const reordered = {
      settledAt: base.settledAt,
      recipient: base.recipient,
      txId: base.txId,
      outcome: base.outcome,
      amountUct: base.amountUct,
      provider: base.provider,
      buyer: base.buyer,
      escrowRef: base.escrowRef,
      listingId: base.listingId,
      jobId: base.jobId,
      v: base.v,
    } as SettlementReceipt;
    expect(canonicalReceipt(base)).toBe(canonicalReceipt(reordered));
  });

  it('changes when any signed field changes', () => {
    expect(canonicalReceipt(base)).not.toBe(canonicalReceipt({ ...base, amountUct: 11 }));
    expect(canonicalReceipt(base)).not.toBe(canonicalReceipt({ ...base, outcome: 'refund' }));
    expect(canonicalReceipt(base)).not.toBe(canonicalReceipt({ ...base, recipient: `03${'b'.repeat(64)}` }));
  });

  it('treats a missing txId as an empty string', () => {
    const { txId: _omit, ...noTx } = base;
    expect(canonicalReceipt(noTx as SettlementReceipt)).toBe(canonicalReceipt({ ...base, txId: '' }));
  });
});
