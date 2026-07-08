import type { Tier } from '@bazaar/core';

const TIER_COLOR: Record<Tier, string> = {
  gold: '#e8b100',
  silver: '#9aa0a6',
  bronze: '#c07b3a',
  new: '#5a5a5a',
};

const xml = (s: string): string =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

// Rough width of a string at 11px in the badge font (monospace-ish).
const textWidth = (s: string): number => Math.ceil(s.length * 6.6) + 14;

/**
 * A shields-style embeddable trust badge (self-contained SVG). Left segment is
 * the provider handle, right segment the tier + score in the tier's colour.
 * Providers drop `<img src=".../api/badge/@you.svg">` on their site.
 */
export function renderBadge(handle: string, score: number, tier: Tier): string {
  const label = handle.length > 22 ? `${handle.slice(0, 21)}…` : handle;
  const value = tier === 'new' ? 'new' : `${tier} ${score}`;
  const lw = textWidth(label);
  const vw = textWidth(value);
  const w = lw + vw;
  const color = TIER_COLOR[tier];
  const cx = lw + vw / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${xml(label)}: ${xml(value)}">
  <title>${xml(label)}: ${xml(value)}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="4" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="20" fill="#0d0d0d"/>
    <rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14" fill="#010101" fill-opacity=".3">${xml(label)}</text>
    <text x="${lw / 2}" y="13">${xml(label)}</text>
    <text x="${cx}" y="14" fill="#010101" fill-opacity=".3">${xml(value)}</text>
    <text x="${cx}" y="13" fill="#1a0d00">${xml(value)}</text>
  </g>
</svg>`;
}
