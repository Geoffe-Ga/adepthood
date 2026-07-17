import { describe, expect, it } from '@jest/globals';

import { fuzzyMatch, rankMatches } from '@/components/drawer/fuzzyMatch';

describe('fuzzyMatch', () => {
  it('matches every query token as an exact token substring of the candidate', () => {
    expect(fuzzyMatch('mood of blue', 'The Mood of Blue: Love—Community Love')).toBe(true);
  });

  it('matches a query token that is one edit away from a candidate token', () => {
    expect(fuzzyMatch('moob of blue', 'The Mood of Blue reflections')).toBe(true);
  });

  it('folds a diacritic in the candidate to match a plain query token', () => {
    expect(fuzzyMatch('cafe', 'Café days')).toBe(true);
  });

  it('folds a diacritic in the query to match a plain candidate token', () => {
    expect(fuzzyMatch('café', 'cafe day')).toBe(true);
  });

  it('returns false when no query token relates to any candidate token', () => {
    expect(fuzzyMatch('green', 'The Mood of Blue')).toBe(false);
  });

  it('normalizes punctuation and an em-dash to whitespace before tokenizing', () => {
    expect(fuzzyMatch('love community', 'Love—Community Love')).toBe(true);
  });

  it('matches a query token that is a character-subsequence of a candidate token', () => {
    expect(fuzzyMatch('bue of blue', 'The Mood of Blue')).toBe(true);
  });

  it('treats an empty query as matching any candidate', () => {
    expect(fuzzyMatch('', 'anything at all')).toBe(true);
  });

  it('treats a whitespace-only query as matching any candidate', () => {
    expect(fuzzyMatch('   ', 'anything')).toBe(true);
  });

  it('returns false for a non-empty query against an empty candidate', () => {
    expect(fuzzyMatch('blue', '')).toBe(false);
  });

  it('rejects a token that is two edits away and not a subsequence of any candidate token', () => {
    expect(fuzzyMatch('xyood', 'The Mood of Blue')).toBe(false);
  });

  it('does not fuzzy-match a two-character token below the length-3 guard', () => {
    expect(fuzzyMatch('xz', 'The Mood of Blue')).toBe(false);
  });
});

interface Entry {
  title: string;
}

const getTitle = (entry: Entry): string => entry.title;

describe('rankMatches', () => {
  it('filters out items whose text does not match the query', () => {
    const items: Entry[] = [{ title: 'Blue Skies Ahead' }, { title: 'Green Fields' }];

    const result = rankMatches('blue', items, getTitle);

    expect(result).toEqual([{ title: 'Blue Skies Ahead' }]);
  });

  it('ranks an exact token match above a weaker fuzzy edit-distance match', () => {
    const exact: Entry = { title: 'Blue Skies Ahead' };
    const fuzzy: Entry = { title: 'The Blur of Motion' };

    const result = rankMatches('blue', [fuzzy, exact], getTitle);

    expect(result).toEqual([exact, fuzzy]);
  });

  it('keeps equally-scoring items in their original input order (stable sort)', () => {
    const first: Entry = { title: 'Blue Diary' };
    const second: Entry = { title: 'Blue Notebook' };

    const result = rankMatches('blue', [first, second], getTitle);

    expect(result).toEqual([first, second]);
  });

  it('returns all items in original order for an empty query', () => {
    const items: Entry[] = [
      { title: 'Blue Skies Ahead' },
      { title: 'Green Fields' },
      { title: 'The Mood of Blue' },
    ];

    const result = rankMatches('', items, getTitle);

    expect(result).toEqual(items);
  });

  it('uses the getText accessor rather than assuming a string item', () => {
    const items: Entry[] = [{ title: 'Café Reflections' }];

    const result = rankMatches('cafe', items, getTitle);

    expect(result).toEqual(items);
  });
});
