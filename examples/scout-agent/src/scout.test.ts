import { describe, expect, it } from 'vitest';
import { scout } from './scout.js';

describe('scout', () => {
  it('counts words, chars, and sentences', () => {
    const r = scout({ text: 'Hello world. This is fine!' });
    expect(r.words).toBe(5);
    expect(r.chars).toBe(26);
    expect(r.sentences).toBe(2);
  });

  it('surfaces top keywords, excluding stopwords and short tokens', () => {
    const r = scout({ text: 'bazaar bazaar bazaar agent agent the the the it is' });
    expect(r.topKeywords[0]).toEqual({ word: 'bazaar', count: 3 });
    expect(r.topKeywords[1]).toEqual({ word: 'agent', count: 2 });
    expect(r.topKeywords.some((k) => k.word === 'the')).toBe(false);
  });

  it('reads sentiment from a naive lexicon', () => {
    expect(scout({ text: 'this is a great and reliable solid win' }).sentiment).toBe('positive');
    expect(scout({ text: 'a risky broken scam with an exploit' }).sentiment).toBe('negative');
    expect(scout({ text: 'a plain neutral sentence about nothing' }).sentiment).toBe('neutral');
  });

  it('handles empty input gracefully', () => {
    const r = scout({});
    expect(r.words).toBe(0);
    expect(r.target).toBe('nothing');
    expect(r.sentiment).toBe('neutral');
    expect(r.topKeywords).toEqual([]);
  });

  it('labels the target with the provided url', () => {
    expect(scout({ text: 'x y z', url: 'https://a.b/post' }).target).toBe('https://a.b/post');
  });
});
