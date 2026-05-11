import { describe, expect, it } from '@jest/globals';

import { MAJOR_ARCANA, cardForDayIndex } from '../../data/tarot';
import { TAROT_DECK_SIZE } from '../../engine/types';

const TRADITIONAL_NAMES = [
  'The Fool',
  'The Magician',
  'The High Priestess',
  'The Empress',
  'The Emperor',
  'The Hierophant',
  'The Lovers',
  'The Chariot',
  'Strength',
  'The Hermit',
  'Wheel of Fortune',
  'Justice',
  'The Hanged Man',
  'Death',
  'Temperance',
  'The Devil',
  'The Tower',
  'The Star',
  'The Moon',
  'The Sun',
  'Judgement',
  'The World',
] as const;

describe('MAJOR_ARCANA', () => {
  it('contains exactly 22 cards', () => {
    expect(MAJOR_ARCANA).toHaveLength(TAROT_DECK_SIZE);
  });

  it('has unique, contiguous indices 0..21', () => {
    const indices = MAJOR_ARCANA.map((c) => c.index);
    expect(indices).toEqual(Array.from({ length: TAROT_DECK_SIZE }, (_, i) => i));
  });

  it('lists the names in traditional order', () => {
    expect(MAJOR_ARCANA.map((c) => c.name)).toEqual(TRADITIONAL_NAMES);
  });

  it('keeps keywords and symbolism under 80 characters', () => {
    for (const card of MAJOR_ARCANA) {
      expect(card.keyword.length).toBeLessThanOrEqual(80);
      expect(card.symbolism.length).toBeLessThanOrEqual(80);
      expect(card.keyword.length).toBeGreaterThan(0);
      expect(card.symbolism.length).toBeGreaterThan(0);
    }
  });
});

describe('cardForDayIndex', () => {
  it('returns The Fool on day 0', () => {
    expect(cardForDayIndex(0).name).toBe('The Fool');
  });

  it('returns The World on day 21', () => {
    expect(cardForDayIndex(21).name).toBe('The World');
  });

  it('wraps back to The Fool on day 22', () => {
    expect(cardForDayIndex(22).name).toBe('The Fool');
  });

  it('agrees with MAJOR_ARCANA[100 % 22] for large day offsets', () => {
    const expected = MAJOR_ARCANA[100 % TAROT_DECK_SIZE];
    expect(cardForDayIndex(100)).toEqual(expected);
  });

  it('handles negative inputs by normalising into the deck range', () => {
    // Defensive: callers should clamp at 0, but we should still return a
    // valid card rather than `undefined` if a clock bug produces -1.
    expect(cardForDayIndex(-1)).toEqual(MAJOR_ARCANA[TAROT_DECK_SIZE - 1]);
  });
});
