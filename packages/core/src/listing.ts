import { CATEGORIES, type Category, type DeliveryChannel, type Listing } from './protocol.js';
import { shortId, slugify } from './ids.js';

export interface ListingInput {
  agentNametag: string;
  title: string;
  description: string;
  category: string;
  priceUct: number;
  channel: DeliveryChannel;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Validate raw listing input. Returns every problem found (not just the first). */
export function validateListing(input: ListingInput): ValidationResult {
  const errors: string[] = [];
  const nametag = (input.agentNametag ?? '').trim().replace(/^@/, '');
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(nametag)) errors.push('agentNametag must be 2-32 chars [a-zA-Z0-9_-]');
  if (!input.title?.trim()) errors.push('title is required');
  if ((input.title?.length ?? 0) > 80) errors.push('title must be <= 80 chars');
  if (!input.description?.trim()) errors.push('description is required');
  if (!CATEGORIES.includes(input.category as Category)) {
    errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
  }
  if (!Number.isInteger(input.priceUct) || input.priceUct <= 0) {
    errors.push('priceUct must be a positive integer');
  } else if (input.priceUct > 1_000_000) {
    errors.push('priceUct is unreasonably high');
  }
  if (input.channel?.kind === 'webhook') {
    if (!isHttpUrl(input.channel.url)) errors.push('webhook url must be a valid http(s) URL');
  } else if (input.channel?.kind === 'capsule') {
    if (!input.channel.ref?.trim()) errors.push('capsule ref is required');
  } else {
    errors.push('channel must be a webhook or capsule');
  }
  return { ok: errors.length === 0, errors };
}

/** Build a validated `Listing`. Throws if the input is invalid. */
export function makeListing(input: ListingInput, now = Date.now()): Listing {
  const check = validateListing(input);
  if (!check.ok) throw new Error(`invalid listing: ${check.errors.join('; ')}`);
  const nametag = input.agentNametag.trim().replace(/^@/, '');
  const slug = `${slugify(nametag)}-${slugify(input.title)}`.replace(/-+/g, '-');
  return {
    id: shortId('listing', nametag, input.title, String(now)),
    slug,
    agentNametag: `@${nametag}`,
    title: input.title.trim(),
    description: input.description.trim(),
    category: input.category as Category,
    priceUct: input.priceUct,
    channel: input.channel,
    active: true,
    createdAt: now,
  };
}
