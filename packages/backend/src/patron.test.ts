import { describe, expect, it, vi } from 'vitest';
import type { JobView, ListingLite } from '@bazaar/agent-kit';
import { AutonomousPatron, type PatronBuyer, type PatronOptions, type PatronWallet } from './patron.js';

const CHAIN_PUBKEY = `02${'a'.repeat(64)}`;

function walletStub(balance = 1000): PatronWallet {
  return {
    start: vi.fn(async () => ({})),
    stop: vi.fn(async () => {}),
    signMessage: vi.fn((m: string) => `sig:${m}`),
    send: vi.fn(async () => ({ id: 'tx-1' })),
    mintUct: vi.fn(async () => ({})),
    balanceUct: vi.fn(async () => String(balance)),
    chainPubkey: CHAIN_PUBKEY,
    nametag: 'patron-test',
  };
}

function jobView(listingId: string): JobView {
  return {
    job: { jobId: `job-${listingId}`, escrowRef: 'e', listingId, state: 'released', amountUct: 1, updatedAt: Date.now() },
  } as JobView;
}

function buyerStub(listings: ListingLite[]) {
  const hired: { listingId: string; input: unknown }[] = [];
  const buyer: PatronBuyer = {
    login: vi.fn(async () => {}),
    listings: vi.fn(async () => listings),
    hireAndSettle: vi.fn(async (listingId: string, input: unknown) => {
      hired.push({ listingId, input });
      return jobView(listingId);
    }),
  };
  return { buyer, hired };
}

function listing(id: string, agentNametag: string, extra: Partial<ListingLite> = {}): ListingLite {
  return {
    id,
    slug: id,
    agentNametag,
    title: `Agent ${id}`,
    description: '',
    category: 'analysis',
    priceUct: 2,
    ...extra,
  };
}

const baseOpts = (wallet: PatronWallet, buyer: PatronBuyer): PatronOptions => ({
  mnemonic: 'x',
  nametag: 'patron-test',
  intervalMs: 60_000,
  baseUrl: 'http://127.0.0.1:4600',
  dataDir: '/tmp',
  network: 'testnet2',
  oracleApiKey: 'k',
  walletApiUrl: 'http://localhost',
  wallet,
  buyer,
});

describe('AutonomousPatron', () => {
  it('bootstraps to the same principal the server keys jobs by', async () => {
    const { buyer } = buyerStub([]);
    const patron = new AutonomousPatron(baseOpts(walletStub(), buyer));
    expect(await patron.bootstrap()).toBe(true);
    expect(buyer.login).toHaveBeenCalledOnce();
    // principalOf({ nametag: 'patron-test' }) === '@patron-test'
    expect(patron.principal).toBe('@patron-test');
  });

  it('discovers, picks, and hires a listing end-to-end', async () => {
    const { buyer, hired } = buyerStub([listing('a', '@other')]);
    const patron = new AutonomousPatron(baseOpts(walletStub(), buyer));
    await patron.bootstrap();
    await patron.runCycle();
    expect(hired).toEqual([{ listingId: 'a', input: expect.objectContaining({ text: expect.any(String) }) }]);
    expect(patron.stats()).toMatchObject({ cycles: 1, hires: 1, lastState: 'released', intervalMs: 60_000 });
  });

  it('never hires its own listing', async () => {
    const { buyer, hired } = buyerStub([listing('mine', '@patron-test'), listing('rival', '@rival')]);
    const patron = new AutonomousPatron(baseOpts(walletStub(), buyer));
    await patron.bootstrap();
    await patron.runCycle();
    expect(hired.map((h) => h.listingId)).toEqual(['rival']);
  });

  it('does nothing when only its own listing exists', async () => {
    const { buyer, hired } = buyerStub([listing('mine', '@patron-test')]);
    const patron = new AutonomousPatron(baseOpts(walletStub(), buyer));
    await patron.bootstrap();
    await patron.runCycle();
    expect(hired).toEqual([]);
    expect(patron.stats().hires).toBe(0);
  });

  it('rotates across eligible listings on successive cycles', async () => {
    const { buyer, hired } = buyerStub([listing('a', '@x'), listing('b', '@y')]);
    const patron = new AutonomousPatron(baseOpts(walletStub(), buyer));
    await patron.bootstrap();
    await patron.runCycle();
    await patron.runCycle();
    expect(hired.map((h) => h.listingId)).toEqual(['a', 'b']);
  });

  it('sends a game input for game-category listings', async () => {
    const { buyer, hired } = buyerStub([listing('g', '@x', { category: 'game' })]);
    const patron = new AutonomousPatron(baseOpts(walletStub(), buyer));
    await patron.bootstrap();
    await patron.runCycle();
    expect(hired[0]!.input).toEqual({ sides: 6, rolls: 3 });
  });

  it('respects the price cap', async () => {
    const { buyer, hired } = buyerStub([listing('cheap', '@x', { priceUct: 2 }), listing('whale', '@y', { priceUct: 9999 })]);
    const patron = new AutonomousPatron(baseOpts(walletStub(), buyer));
    await patron.bootstrap();
    await patron.runCycle();
    expect(hired.map((h) => h.listingId)).toEqual(['cheap']);
  });

  it('tops up the wallet when the balance is low', async () => {
    const wallet = walletStub(5); // below the 25 UCT floor
    const { buyer } = buyerStub([listing('a', '@x')]);
    const patron = new AutonomousPatron(baseOpts(wallet, buyer));
    await patron.bootstrap();
    await patron.runCycle();
    expect(wallet.mintUct).toHaveBeenCalledOnce();
  });

  it('does not mint when the balance is healthy', async () => {
    const wallet = walletStub(1000);
    const { buyer } = buyerStub([listing('a', '@x')]);
    const patron = new AutonomousPatron(baseOpts(wallet, buyer));
    await patron.bootstrap();
    await patron.runCycle();
    expect(wallet.mintUct).not.toHaveBeenCalled();
  });

  it('records a failed cycle without throwing', async () => {
    const { buyer } = buyerStub([listing('a', '@x')]);
    (buyer.hireAndSettle as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('escrow timed out'));
    const patron = new AutonomousPatron(baseOpts(walletStub(), buyer));
    await patron.bootstrap();
    await expect(patron.runCycle()).resolves.toBeUndefined();
    expect(patron.stats()).toMatchObject({ cycles: 1, hires: 0, lastError: 'escrow timed out' });
  });
});
