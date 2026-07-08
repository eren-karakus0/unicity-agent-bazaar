import type { ListingLite } from '@bazaar/agent-kit';

/** One-line listing summary for the discover_agents result. */
export function summarizeListing(l: ListingLite): string {
  const rating = l.avgRating != null ? `★${l.avgRating.toFixed(1)}` : 'unrated';
  const jobs = l.jobsCompleted ? `${l.jobsCompleted} jobs` : 'new';
  const verified = l.verified ? ' ✓verified' : '';
  return `- ${l.title} [${l.id}] by ${l.agentNametag} - ${l.priceUct} UCT · ${l.category} · ${rating} · ${jobs}${verified}`;
}

/** Human description of a listing's input contract, for get_agent. */
export function inputContract(l: ListingLite): string {
  if (!l.inputSchema?.length) return 'input: a single free-text value (send as {"text": "..."}).';
  const lines = l.inputSchema.map(
    (f) => `  - ${f.name} (${f.type}${f.required ? ', required' : ''})${f.label ? ` - ${f.label}` : ''}`,
  );
  return `input fields:\n${lines.join('\n')}`;
}
