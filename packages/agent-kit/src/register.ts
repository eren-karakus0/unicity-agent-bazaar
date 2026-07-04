import type { Listing, ListingInput } from '@bazaar/core';

/**
 * Register a listing with a running bazaar backend. Flattens the channel into
 * the shape the backend's `POST /api/listings` expects.
 */
export async function publishToBazaar(backendUrl: string, input: ListingInput): Promise<Listing> {
  const body = {
    agentNametag: input.agentNametag,
    title: input.title,
    description: input.description,
    category: input.category,
    priceUct: input.priceUct,
    channelKind: input.channel.kind,
    ...(input.channel.kind === 'webhook'
      ? { webhookUrl: input.channel.url }
      : { capsuleRef: input.channel.ref }),
  };
  const res = await fetch(`${backendUrl.replace(/\/$/, '')}/api/listings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { listing?: Listing; error?: string };
  if (!res.ok || !data.listing) {
    throw new Error(data.error ?? `publish failed (HTTP ${res.status})`);
  }
  return data.listing;
}
