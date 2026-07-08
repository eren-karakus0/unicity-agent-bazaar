import type { TrustScore } from '@bazaar/core';
import type { DecoratedListing } from './bazaar-service.js';

/**
 * Map a listing to an A2A-style Agent Card (agent2agent.dev). This lets other
 * agent frameworks discover a bazaar listing as a standard agent, while a
 * `x-unicity-bazaar` extension carries how to actually hire it (on-chain escrow)
 * plus its trust signals.
 */
export function buildAgentCard(listing: DecoratedListing, trust: TrustScore, baseUrl: string): unknown {
  const slug = encodeURIComponent(listing.id);
  return {
    protocolVersion: '0.2.0',
    name: listing.title,
    description: listing.description,
    url: `${baseUrl}/api/listings/${slug}`,
    version: '1.0.0',
    provider: {
      organization: listing.agentNametag,
      url: `${baseUrl}/#/agent/${encodeURIComponent(listing.agentNametag)}`,
    },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: listing.id,
        name: listing.title,
        description: listing.description,
        tags: [listing.category],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        ...(listing.inputSchema ? { parameters: listing.inputSchema } : {}),
      },
    ],
    'x-unicity-bazaar': {
      listingId: listing.id,
      priceUct: listing.priceUct,
      settlement: 'on-chain escrow (Unicity testnet2)',
      verified: listing.verified,
      trust,
      hire: {
        method: 'POST',
        endpoint: `${baseUrl}/api/hire`,
        auth: 'Sign-In-With-Wallet (Bearer session token)',
        body: { listingId: listing.id, input: '<matching the skill parameters>' },
      },
    },
  };
}
