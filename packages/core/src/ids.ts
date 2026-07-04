import { createHash, randomUUID } from 'node:crypto';

/** A short, stable id derived from parts (12 hex chars). */
export function shortId(...parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 12);
}

/** A fresh, unique job id. */
export function newJobId(): string {
  return `job_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** An escrow reference the provider can quote back (opaque, unique). */
export function newEscrowRef(): string {
  return `esc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** A URL-friendly slug from arbitrary text (Unicode letters/numbers kept). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
