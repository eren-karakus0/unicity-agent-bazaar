import { describe, expect, it } from 'vitest';
import { canonicalMandate, checkMandate, type SpendingMandate } from './mandate.js';

const base: SpendingMandate = {
  v: 1,
  mandateId: 'm1',
  buyer: '02buyer',
  agent: '02agent',
  maxTotalUct: 100,
  maxPerJobUct: 25,
  categories: ['analysis', 'data'],
  expiresAt: 2_000_000_000_000,
  createdAt: 1_000,
};

describe('canonicalMandate', () => {
  it('is stable regardless of category ordering', () => {
    const a = canonicalMandate({ ...base, categories: ['data', 'analysis'] });
    const b = canonicalMandate({ ...base, categories: ['analysis', 'data'] });
    expect(a).toBe(b);
  });

  it('changes when a budget field changes', () => {
    expect(canonicalMandate(base)).not.toBe(canonicalMandate({ ...base, maxTotalUct: 101 }));
  });
});

describe('checkMandate', () => {
  const now = 1_000_000;

  it('allows a hire within all caps and categories', () => {
    expect(checkMandate(base, 0, '02agent', 20, 'analysis', now)).toEqual({ ok: true });
  });

  it('rejects a different agent', () => {
    const r = checkMandate(base, 0, '02someoneelse', 10, 'analysis', now);
    expect(r.ok).toBe(false);
  });

  it('rejects over the per-job cap', () => {
    const r = checkMandate(base, 0, '02agent', 26, 'analysis', now);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain('per-job');
  });

  it('rejects when it would exceed the remaining budget', () => {
    const r = checkMandate(base, 90, '02agent', 20, 'analysis', now);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain('remaining');
  });

  it('rejects a category not on the allow-list', () => {
    const r = checkMandate(base, 0, '02agent', 10, 'creative', now);
    expect(r.ok).toBe(false);
  });

  it('accepts any category when the mandate allows "*"', () => {
    const wild = { ...base, categories: ['*'] };
    expect(checkMandate(wild, 0, '02agent', 10, 'creative', now)).toEqual({ ok: true });
  });

  it('rejects an expired mandate', () => {
    const r = checkMandate(base, 0, '02agent', 10, 'analysis', base.expiresAt + 1);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain('expired');
  });

  it('is case-insensitive on the agent pubkey', () => {
    expect(checkMandate(base, 0, '02AGENT', 10, 'analysis', now)).toEqual({ ok: true });
  });
});
