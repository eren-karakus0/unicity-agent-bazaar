import {
  CATEGORIES,
  INPUT_FIELD_TYPES,
  type Category,
  type DeliveryChannel,
  type InputField,
  type InputFieldType,
  type Listing,
} from './protocol.js';
import { shortId, slugify } from './ids.js';

export interface ListingInput {
  agentNametag: string;
  title: string;
  description: string;
  category: string;
  priceUct: number;
  channel: DeliveryChannel;
  /** Optional declared input contract for the hire form. */
  inputSchema?: InputField[];
}

const FIELD_NAME_RE = /^[a-zA-Z0-9_]{1,32}$/;
const MAX_FIELDS = 12;

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
  validateInputSchema(input.inputSchema, errors);
  return { ok: errors.length === 0, errors };
}

/** Validate an optional input schema: unique valid names, labels, known types. */
function validateInputSchema(schema: InputField[] | undefined, errors: string[]): void {
  if (schema === undefined) return;
  if (!Array.isArray(schema)) {
    errors.push('inputSchema must be an array of fields');
    return;
  }
  if (schema.length > MAX_FIELDS) errors.push(`inputSchema may declare at most ${MAX_FIELDS} fields`);
  const seen = new Set<string>();
  for (const f of schema) {
    const name = (f?.name ?? '').trim();
    if (!FIELD_NAME_RE.test(name)) {
      errors.push(`field name "${name}" must be 1-32 chars [a-zA-Z0-9_]`);
    } else if (seen.has(name)) {
      errors.push(`duplicate field name "${name}"`);
    } else {
      seen.add(name);
    }
    if (!f?.label?.trim()) errors.push(`field "${name}" needs a label`);
    else if (f.label.length > 60) errors.push(`field "${name}" label must be <= 60 chars`);
    if (!INPUT_FIELD_TYPES.includes(f?.type as InputFieldType)) {
      errors.push(`field "${name}" type must be one of: ${INPUT_FIELD_TYPES.join(', ')}`);
    }
  }
}

/** Strip an input schema down to clean, known-shape fields (drops junk props). */
function normalizeSchema(schema: InputField[]): InputField[] {
  return schema.map((f) => ({
    name: f.name.trim(),
    label: f.label.trim(),
    type: f.type,
    ...(f.required ? { required: true } : {}),
    ...(f.placeholder?.trim() ? { placeholder: f.placeholder.trim() } : {}),
    ...(f.help?.trim() ? { help: f.help.trim() } : {}),
  }));
}

/** Build a validated `Listing`. Throws if the input is invalid. */
export function makeListing(input: ListingInput, now = Date.now()): Listing {
  const check = validateListing(input);
  if (!check.ok) throw new Error(`invalid listing: ${check.errors.join('; ')}`);
  const nametag = input.agentNametag.trim().replace(/^@/, '');
  const slug = `${slugify(nametag)}-${slugify(input.title)}`.replace(/-+/g, '-');
  const inputSchema = input.inputSchema?.length ? normalizeSchema(input.inputSchema) : undefined;
  return {
    id: shortId('listing', nametag, input.title, String(now)),
    slug,
    agentNametag: `@${nametag}`,
    title: input.title.trim(),
    description: input.description.trim(),
    category: input.category as Category,
    priceUct: input.priceUct,
    channel: input.channel,
    ...(inputSchema ? { inputSchema } : {}),
    active: true,
    createdAt: now,
  };
}
