import { describe, expect, it } from '@jest/globals';

import { HYPHENATION_BREAKS, hyphenate } from '../hyphenation';

describe('hyphenate', () => {
  it.each([
    ['Awareness', ['Aware-', 'ness']],
    ['Understanding', ['Under-', 'standing']],
    ['Yes-And-Ness', ['Yes-And-', 'Ness']],
  ])('breaks %s where the Map has always broken it', (word, lines) => {
    expect(hyphenate(word)).toEqual(lines);
  });

  it.each(['Love', 'Wisdom', 'Being', 'Zephyr', 'Kindness'])(
    'keeps %s whole: an unlisted word is one line that the fit wraps itself',
    (word) => {
      expect(hyphenate(word)).toEqual([word]);
    },
  );

  it('does not read inherited object keys as break points', () => {
    expect(hyphenate('constructor')).toEqual(['constructor']);
    expect(hyphenate('toString')).toEqual(['toString']);
  });

  it('splits each listed word into its own letters, in order, and nothing else', () => {
    const letters = (text: string): string => text.replace(/-/gu, '');
    for (const [word, lines] of HYPHENATION_BREAKS) {
      expect(letters(lines.join(''))).toBe(letters(word));
      expect(lines.length).toBeGreaterThan(1);
    }
  });
});
