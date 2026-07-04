/**
 * A deterministic "text scout" — the work a provider agent actually does. Pure,
 * dependency-free, no API keys: it turns a chunk of text into a quick content
 * report. Kept separate from the server wiring so it can be unit-tested.
 */
export interface ScoutInput {
  text?: string;
  /** Optional label for what the text is (e.g. a URL); only used in the report. */
  url?: string;
}

export interface Keyword {
  word: string;
  count: number;
}

export interface ScoutReport {
  target: string;
  words: number;
  chars: number;
  sentences: number;
  readingSeconds: number;
  sentiment: 'positive' | 'neutral' | 'negative';
  topKeywords: Keyword[];
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were',
  'it', 'this', 'that', 'with', 'as', 'at', 'by', 'be', 'from', 'i', 'you', 'he', 'she', 'they',
  'we', 'my', 'your', 'so', 'if', 'not', 'no', 'do', 'does', 'has', 'have', 'had', 'will', 'can',
]);
const POSITIVE = new Set([
  'good', 'great', 'excellent', 'safe', 'secure', 'love', 'best', 'win', 'fast', 'clean', 'solid',
  'strong', 'nice', 'happy', 'success', 'reliable', 'trusted',
]);
const NEGATIVE = new Set([
  'bad', 'risk', 'risky', 'bug', 'vulnerability', 'hack', 'slow', 'broken', 'fail', 'scam',
  'danger', 'weak', 'loss', 'error', 'exploit', 'unsafe', 'malicious',
]);

export function scout(input: ScoutInput): ScoutReport {
  const text = String(input?.text ?? '');
  const target = input?.url?.trim() || (text.trim() ? 'inline text' : 'nothing');
  const tokens = (text.toLowerCase().match(/\p{Letter}+/gu) ?? []) as string[];
  const words = tokens.length;
  const chars = text.length;
  const sentences = (text.match(/[.!?]+/g) ?? []).length || (words > 0 ? 1 : 0);
  const readingSeconds = Math.round((words / 200) * 60); // ~200 words per minute

  const freq = new Map<string, number>();
  let pos = 0;
  let neg = 0;
  for (const t of tokens) {
    if (POSITIVE.has(t)) pos++;
    if (NEGATIVE.has(t)) neg++;
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const topKeywords: Keyword[] = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));

  const sentiment = pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
  return { target, words, chars, sentences, readingSeconds, sentiment, topKeywords };
}
