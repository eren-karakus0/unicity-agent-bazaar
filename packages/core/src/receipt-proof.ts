/**
 * Settlement receipts - the bazaar's proof that a job settled, and how.
 *
 * When an escrow releases or refunds, the platform signs a canonical statement
 * of the outcome with the escrow wallet's key. Anyone can later verify that
 * signature against the escrow's public chain key (with the Sphere SDK's
 * `verifySignedMessage`) - so a settlement is independently provable and
 * non-repudiable, not "trust the API". The receipt also carries the on-chain
 * settlement `txId`, tying the attestation to the Unicity ledger entry.
 *
 * This module is dependency-free: it only defines the receipt shape and the
 * exact bytes that get signed. The signing/verifying (secp256k1) lives wherever
 * the SDK is available (backend signs; backend, MCP, or anyone verifies).
 */

export type SettlementOutcome = 'release' | 'refund';

/** The canonical, signed statement of a settled job. */
export interface SettlementReceipt {
  v: 1;
  jobId: string;
  listingId: string;
  escrowRef: string;
  /** Buyer principal (@nametag or chain pubkey). */
  buyer: string;
  /** Provider principal (@nametag or chain pubkey). */
  provider: string;
  amountUct: number;
  outcome: SettlementOutcome;
  /** The chain pubkey that received the funds. */
  recipient: string;
  /** On-chain settlement transaction id (the Unicity ledger reference). */
  txId?: string;
  settledAt: number;
}

/** A receipt plus the escrow wallet's signature over its canonical form. */
export interface SignedReceipt {
  receipt: SettlementReceipt;
  /** 130-hex secp256k1 signature (v+r+s) over `canonicalReceipt(receipt)`. */
  signature: string;
  /** The escrow wallet's compressed chain pubkey that produced the signature. */
  signer: string;
}

/**
 * The exact string that gets signed and verified. Field order is fixed here (not
 * left to `JSON.stringify` key order) so the signed bytes are stable across
 * platforms and versions. Never reorder these without bumping `v`.
 */
export function canonicalReceipt(r: SettlementReceipt): string {
  return JSON.stringify([
    'bazaar-receipt',
    r.v,
    r.jobId,
    r.listingId,
    r.escrowRef,
    r.buyer,
    r.provider,
    r.amountUct,
    r.outcome,
    r.recipient,
    r.txId ?? '',
    r.settledAt,
  ]);
}
