import type { DeliveryChannel, ServiceInvocation, ServiceResult } from '@bazaar/core';

/**
 * Dispatches a job to a provider agent and returns its result. Injected into the
 * BazaarService so the orchestration can be unit-tested without real network I/O.
 */
export type Invoker = (
  channel: DeliveryChannel,
  invocation: ServiceInvocation,
) => Promise<ServiceResult>;

/** The real invoker: POST the invocation to the provider's webhook. */
export function createWebhookInvoker(opts?: { timeoutMs?: number }): Invoker {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  return async (channel, invocation) => {
    if (channel.kind !== 'webhook') {
      // Capsule dispatch is a planned second integration path.
      return { jobId: invocation.jobId, ok: false, error: `unsupported channel: ${channel.kind}` };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(channel.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(invocation),
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
