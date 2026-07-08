import { describe, expect, it } from 'vitest';
import { makeListing, validateListing, type ListingInput } from './listing.js';

const good: ListingInput = {
  agentNametag: '@scout-knkchn',
  title: 'On-demand repo risk analysis',
  description: 'Point me at a GitHub repo and I return a risk report.',
  category: 'analysis',
  priceUct: 5,
  channel: { kind: 'webhook', url: 'https://scout.example.com/hook' },
};

describe('validateListing', () => {
  it('accepts a well-formed listing', () => {
    expect(validateListing(good)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a bad nametag, empty title, and non-positive price', () => {
    const r = validateListing({ ...good, agentNametag: 'a', title: '', priceUct: 0 });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects an unknown category', () => {
    expect(validateListing({ ...good, category: 'gambling' }).ok).toBe(false);
  });

  it('rejects a non-http webhook and an empty capsule ref', () => {
    expect(validateListing({ ...good, channel: { kind: 'webhook', url: 'ftp://x' } }).ok).toBe(false);
    expect(validateListing({ ...good, channel: { kind: 'capsule', ref: '' } }).ok).toBe(false);
  });

  it('accepts a capsule channel with a ref', () => {
    expect(validateListing({ ...good, channel: { kind: 'capsule', ref: 'arcade-player' } }).ok).toBe(true);
  });
});

describe('validateListing - input schema', () => {
  it('accepts a valid declared schema', () => {
    const r = validateListing({
      ...good,
      inputSchema: [
        { name: 'repo', label: 'Repository URL', type: 'url', required: true },
        { name: 'deep', label: 'Deep scan', type: 'boolean' },
      ],
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it('rejects bad field names, duplicates, and unknown types', () => {
    const r = validateListing({
      ...good,
      inputSchema: [
        { name: 'ok field!', label: 'Bad name', type: 'text' },
        { name: 'dup', label: 'One', type: 'text' },
        { name: 'dup', label: 'Two', type: 'text' },
        { name: 'x', label: 'Bad type', type: 'money' as never },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /1-32 chars/.test(e))).toBe(true);
    expect(r.errors.some((e) => /duplicate field/.test(e))).toBe(true);
    expect(r.errors.some((e) => /type must be one of/.test(e))).toBe(true);
  });

  it('requires a label on every field', () => {
    expect(validateListing({ ...good, inputSchema: [{ name: 'a', label: '  ', type: 'text' }] }).ok).toBe(false);
  });
});

describe('makeListing', () => {
  it('produces a normalized nametag, a slug, and a stable id', () => {
    const l = makeListing(good, 1234);
    expect(l.agentNametag).toBe('@scout-knkchn');
    expect(l.slug).toBe('scout-knkchn-on-demand-repo-risk-analysis');
    expect(l.id).toHaveLength(12);
    expect(l.active).toBe(true);
    expect(l.createdAt).toBe(1234);
  });

  it('is deterministic in its id for the same inputs + timestamp', () => {
    expect(makeListing(good, 42).id).toBe(makeListing(good, 42).id);
  });

  it('throws on invalid input', () => {
    expect(() => makeListing({ ...good, priceUct: -1 })).toThrow(/invalid listing/);
  });

  it('normalizes and keeps a declared input schema, dropping junk props', () => {
    const l = makeListing({
      ...good,
      inputSchema: [
        { name: 'repo', label: '  Repo  ', type: 'url', required: true, placeholder: ' https://… ', extra: 1 } as never,
      ],
    });
    expect(l.inputSchema).toEqual([
      { name: 'repo', label: 'Repo', type: 'url', required: true, placeholder: 'https://…' },
    ]);
  });

  it('omits an empty input schema entirely', () => {
    expect(makeListing({ ...good, inputSchema: [] }).inputSchema).toBeUndefined();
  });
});
