import crypto from 'node:crypto';
import type { DeliveryChannel, ServiceInvocation, ServiceResult } from '@bazaar/core';

/**
 * Dispatches a job to a provider agent and returns its result. Injected into the
 * BazaarService so the orchestration can be unit-tested without real network I/O.
 * `secret` (when present) signs the request so the provider can verify the call.
 */
export type Invoker = (
  channel: DeliveryChannel,
  invocation: ServiceInvocation,
  secret?: string,
) => Promise<ServiceResult>;

/**
 * The signature the Bazaar attaches as `x-bazaar-signature: t=<ms>,v1=<hmac>`.
 * HMAC-SHA256 over `<timestamp>.<rawBody>` — the same scheme agent-kit verifies
 * (mirrors Stripe/GitHub webhook signing). A timestamp binds the signature to a
 * moment so a captured request can't be replayed indefinitely.
 */
function webhookSignature(secret: string, timestamp: number, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Result of probing a provider's `/health` endpoint. */
export interface HealthProbe {
  ok: boolean;
  detail?: string;
}

/** Probes a provider agent's reachability. Injected so publish flow is testable. */
export type HealthProber = (url: string) => Promise<HealthProbe>;

/** The real health prober: a short-timeout GET that treats any 2xx as reachable. */
export function createHealthProber(opts?: { timeoutMs?: number }): HealthProber {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      if (!res.ok) return { ok: false, detail: `health returned HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      return {
        ok: false,
        detail: aborted ? `health timed out after ${timeoutMs}ms` : e instanceof Error ? e.message : 'unreachable',
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The real invoker: POST the invocation to the provider's webhook. */
export function createWebhookInvoker(opts?: { timeoutMs?: number }): Invoker {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  return async (channel, invocation, secret) => {
    if (channel.kind !== 'webhook') {
      // Capsule dispatch is a planned second integration path.
      return { jobId: invocation.jobId, ok: false, error: `unsupported channel: ${channel.kind}` };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = JSON.stringify(invocation);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (secret) {
        const t = Date.now();
        headers['x-bazaar-signature'] = `t=${t},v1=${webhookSignature(secret, t, body)}`;
      }
      const res = await fetch(channel.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        return { jobId: invocation.jobId, ok: false, error: `provider returned HTTP ${res.status}` };
      }
      const data = (await res.json()) as Partial<ServiceResult>;
      return {
        jobId: invocation.jobId,
        ok: data.ok === true,
        output: data.output,
        error: data.ok === true ? undefined : (data.error ?? 'provider reported failure'),
      };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      return {
        jobId: invocation.jobId,
        ok: false,
        error: aborted ? `provider timed out after ${timeoutMs}ms` : e instanceof Error ? e.message : 'invocation failed',
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
