import crypto from 'node:crypto';
import type { ServiceInvocation, ServiceResult } from '@bazaar/core';
import { createLogger, type Logger } from './logger.js';

/**
 * CapsuleHub - the mailbox that makes `kind: 'capsule'` listings live.
 *
 * An Astrid OS capsule cannot receive pushes: it runs inside a WASM sandbox
 * whose only I/O is capability-gated OUTBOUND HTTP (and today's published JS
 * SDK cannot receive kernel bus topics at all). So instead of the platform
 * calling the provider (webhook flow), the provider calls the platform:
 *
 *   funded job on a capsule listing -> enqueue() parks the invocation here
 *   capsule polls  GET  /api/capsule/inbox   -> lease() hands it the work
 *   capsule POSTs  POST /api/capsule/result  -> complete() resolves the job
 *
 * Both endpoints are authenticated with a shared secret (set on both sides
 * via env - never in a repo). If the capsule is offline, enqueue() times out
 * and the job refunds: an honest machine-economy outcome, not a hang. The
 * inbox doubles as a liveness signal - health() drives the listing's
 * "verified" badge from when the capsule last polled.
 */

interface Pending {
  ref: string;
  invocation: ServiceInvocation;
  resolve: (r: ServiceResult) => void;
  timer: ReturnType<typeof setTimeout>;
  leased: boolean;
}

export interface CapsuleHubOptions {
  /** Shared secret the capsule presents on every inbox/result call. */
  secret: string;
  /** How long a funded job waits for the capsule before refunding (default 90s). */
  resultTimeoutMs?: number;
  /** How recent the last poll must be for health() to report ok (default 120s). */
  livenessWindowMs?: number;
  logger?: Logger;
}

export class CapsuleHub {
  private readonly secret: string;
  private readonly resultTimeoutMs: number;
  private readonly livenessWindowMs: number;
  private readonly log: Logger;
  private readonly pending = new Map<string, Pending>();
  /** capsule ref -> when it last polled the inbox (ms). */
  private readonly lastSeen = new Map<string, number>();

  constructor(opts: CapsuleHubOptions) {
    this.secret = opts.secret;
    this.resultTimeoutMs = opts.resultTimeoutMs ?? 90_000;
    this.livenessWindowMs = opts.livenessWindowMs ?? 120_000;
    this.log = opts.logger ?? createLogger('capsule-hub');
  }

  /** Constant-time comparison so the shared secret can't be timing-probed. */
  authorized(presented: string | undefined): boolean {
    const a = Buffer.from(presented ?? '');
    const b = Buffer.from(this.secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Park a funded job's invocation until the capsule picks it up. Resolves
   * with the capsule's result, or - if the capsule never answers - with a
   * failure that refunds the buyer.
   */
  enqueue(ref: string, invocation: ServiceInvocation): Promise<ServiceResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(invocation.jobId);
        this.log.warn(`capsule ${ref} did not answer job ${invocation.jobId} in time - refunding`);
        resolve({
          jobId: invocation.jobId,
          ok: false,
          error: `capsule provider "${ref}" is offline or timed out`,
        });
      }, this.resultTimeoutMs);
      timer.unref?.();
      this.pending.set(invocation.jobId, { ref, invocation, resolve, timer, leased: false });
      this.log.info(`job ${invocation.jobId} parked for capsule ${ref}`);
    });
  }

  /** Hand the capsule its un-leased work and record the poll as liveness. */
  lease(ref: string): ServiceInvocation[] {
    this.lastSeen.set(ref, Date.now());
    const out: ServiceInvocation[] = [];
    for (const p of this.pending.values()) {
      if (p.ref === ref && !p.leased) {
        p.leased = true;
        out.push(p.invocation);
      }
    }
    if (out.length > 0) this.log.info(`capsule ${ref} leased ${out.length} job(s)`);
    return out;
  }

  /** Accept the capsule's result for a leased job. False when nothing matches. */
  complete(jobId: string, result: { ok: boolean; output?: unknown; error?: string }): boolean {
    const p = this.pending.get(jobId);
    if (!p) return false;
    this.pending.delete(jobId);
    clearTimeout(p.timer);
    p.resolve({
      jobId,
      ok: result.ok === true,
      output: result.output,
      error: result.ok === true ? undefined : (result.error ?? 'capsule reported failure'),
    });
    return true;
  }

  /** Liveness-based health for the listing's verified badge. */
  health(ref: string): { ok: boolean; detail?: string } {
    const seen = this.lastSeen.get(ref);
    if (seen === undefined) return { ok: false, detail: 'capsule has not polled its inbox yet' };
    const age = Date.now() - seen;
    if (age > this.livenessWindowMs) {
      return { ok: false, detail: `capsule last polled ${Math.round(age / 1000)}s ago` };
    }
    return { ok: true };
  }
}
