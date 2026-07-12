import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BazaarService, type BazaarAgent } from './bazaar-service.js';
import { createHealthProber, createWebhookInvoker } from './webhook-client.js';
import { startHouseAgents, dealArcadeRound, type HouseAgentsHandle } from './house-agents.js';
import type { Identity } from './auth.js';

// A minimal escrow stub: 2-decimal UCT, records nothing we assert here.
const stubAgent = (): BazaarAgent => ({
  nametag: 'bazaar-escrow',
  uctCoin: { coinId: 'aabb', decimals: 2 },
  toHuman: (smallest) => (Number(BigInt(smallest)) / 100).toString(),
  send: async () => ({ id: 'tx' }),
});

const ESCROW_PUBKEY = `02${'a'.repeat(64)}`;
// A high, unlikely-contended base so the loopback ports are free in CI.
const portBase = 45_000 + Math.floor(Math.random() * 2000);

describe('house agents (real signed loopback path)', () => {
  let house: HouseAgentsHandle | undefined;
  afterEach(async () => {
    await house?.stop();
    house = undefined;
  });

  const boot = async () => {
    // The SSRF guard blocks loopback for user URLs; the house agents register
    // their origins into this shared allowlist, exactly as production wires it.
    const trustedHosts = new Set<string>();
    const svc = new BazaarService({
      agent: stubAgent(),
      invoke: createWebhookInvoker({ timeoutMs: 4000, allowHosts: trustedHosts }),
      probe: createHealthProber({ timeoutMs: 4000, allowHosts: trustedHosts }),
    });
    house = await startHouseAgents({ svc, escrowChainPubkey: ESCROW_PUBKEY, portBase, trustedHosts });
    return svc;
  };

  it('seeds three verified, hireable listings', async () => {
    const svc = await boot();
    const listings = svc.listingsDecorated();
    expect(listings).toHaveLength(3);
    // All answered a real loopback /health probe → verified.
    expect(listings.every((l) => l.verified)).toBe(true);
    expect(listings.every((l) => l.agentNametag === '@bazaar-labs')).toBe(true);
    expect(listings.some((l) => l.title.includes('Arcade House'))).toBe(true);
  });

  it('delivers a job through the signed webhook end-to-end', async () => {
    const svc = await boot();
    const dice = svc.getListings().find((l) => l.title.includes('Dice'))!;
    const buyer: Identity = { chainPubkey: `03${'b'.repeat(64)}`, nametag: 'tester' };
    const hire = svc.hire({ listingId: dice.id, buyer, input: { sides: 6, rolls: 3 } });
    svc.creditFunding({ dedupKey: 'd1', amountBase: String(dice.priceUct * 100), memo: hire.memo });
    await svc.flushJobs();

    const job = svc.getJob(hire.job.jobId)!;
    expect(job.job.state).toBe('delivered');
    expect(job.result?.ok).toBe(true);
    const output = job.result?.output as { results: number[]; total: number };
    expect(output.results).toHaveLength(3);
    expect(output.total).toBeGreaterThanOrEqual(3);
  });

  it('deals a verifiable provably-fair round (commit matches secret+nonce)', () => {
    const round = dealArcadeRound({ game: 'coin' });
    // Anyone can recompute the commit from the revealed secret + nonce.
    expect(createHash('sha256').update(`${round.secret}:${round.nonce}`).digest('hex')).toBe(round.commit);
    // The result is deterministically derived from the revealed secret.
    const draw = parseInt(createHash('sha256').update(round.secret).digest('hex').slice(0, 8), 16);
    expect(round.result).toBe(draw % 2 === 0 ? 'heads' : 'tails');
    expect(round.game).toBe('coin');
    expect(round.outcome).toBeUndefined(); // no pick → no win/lose
  });

  it('judges a caller pick against the fair result', () => {
    const round = dealArcadeRound({ game: 'dice', pick: '3' });
    expect(round.game).toBe('dice');
    expect(['1', '2', '3', '4', '5', '6']).toContain(round.result);
    expect(round.outcome).toBe(round.pick === round.result ? 'win' : 'lose');
  });

  it('rejects an unsigned call to the agent port with 401', async () => {
    await boot();
    const res = await fetch(`http://127.0.0.1:${portBase + 2}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'x', listingId: 'l', buyerNametag: '@a', input: {}, amountUct: 0, escrowRef: 'r' }),
    });
    expect(res.status).toBe(401);
  });
});
