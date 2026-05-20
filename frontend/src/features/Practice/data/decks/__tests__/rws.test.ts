/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { resolveCardImage } from '../../assetResolver';
import { BUNDLED_DECKS, getDeck } from '../index';
import { RWS_CARDS } from '../rws';

const MAJOR_ARCANA_COUNT = 22;
const SUIT_COUNT = 4;
const MINOR_CARDS_PER_SUIT = 14;
const TOTAL_CARDS = MAJOR_ARCANA_COUNT + SUIT_COUNT * MINOR_CARDS_PER_SUIT; // 78
const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

describe('RWS_CARDS', () => {
  it('contains exactly 78 cards', () => {
    expect(RWS_CARDS).toHaveLength(TOTAL_CARDS);
  });

  it('lists the 22 major arcana before any minor card', () => {
    const SUITS = ['wands', 'cups', 'swords', 'pentacles'];
    const isMinor = (slug: string): boolean => SUITS.some((suit) => slug.endsWith(`_of_${suit}`));
    const majors = RWS_CARDS.slice(0, MAJOR_ARCANA_COUNT);
    const minors = RWS_CARDS.slice(MAJOR_ARCANA_COUNT);
    expect(majors).toHaveLength(MAJOR_ARCANA_COUNT);
    expect(majors.every((c) => !isMinor(c.slug))).toBe(true);
    expect(minors.every((c) => isMinor(c.slug))).toBe(true);
  });

  it('contains 14 cards per minor suit (56 total)', () => {
    const suits = ['wands', 'cups', 'swords', 'pentacles'];
    for (const suit of suits) {
      const cards = RWS_CARDS.filter((c) => c.slug.endsWith(`_of_${suit}`));
      expect(cards).toHaveLength(MINOR_CARDS_PER_SUIT);
    }
  });

  it('uses unique slugs across every card', () => {
    const slugs = RWS_CARDS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('uses unique asset_key values across every card', () => {
    const keys = RWS_CARDS.map((c) => c.asset_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses slugs matching ^[a-z][a-z0-9_]*$', () => {
    for (const card of RWS_CARDS) {
      expect(card.slug).toMatch(SLUG_PATTERN);
    }
  });

  it('namespaces every asset_key under the deck id', () => {
    for (const card of RWS_CARDS) {
      expect(card.asset_key).toBe(`rws/${card.slug}`);
    }
  });

  it('keeps name, keyword, and symbolism non-empty for every card', () => {
    for (const card of RWS_CARDS) {
      expect(card.name.length).toBeGreaterThan(0);
      expect(card.keyword.length).toBeGreaterThan(0);
      expect(card.symbolism.length).toBeGreaterThan(0);
    }
  });

  it('keeps keyword and symbolism within their documented length limits', () => {
    const MAX_KEYWORD_LENGTH = 24;
    const MAX_SYMBOLISM_LENGTH = 90;
    for (const card of RWS_CARDS) {
      expect(card.keyword.length).toBeLessThanOrEqual(MAX_KEYWORD_LENGTH);
      expect(card.symbolism.length).toBeLessThanOrEqual(MAX_SYMBOLISM_LENGTH);
    }
  });
});

describe('resolveCardImage', () => {
  it('returns the bundled placeholder for every defined RWS card', () => {
    for (const card of RWS_CARDS) {
      expect(resolveCardImage(card.asset_key)).not.toBeNull();
    }
  });

  it('returns the same image module for every RWS card (single placeholder)', () => {
    const first = resolveCardImage(RWS_CARDS[0]?.asset_key ?? null);
    expect(first).not.toBeNull();
    for (const card of RWS_CARDS) {
      expect(resolveCardImage(card.asset_key)).toBe(first);
    }
  });

  it('returns null for a null asset_key (text-only card)', () => {
    expect(resolveCardImage(null)).toBeNull();
  });

  it('returns null for an unknown asset_key rather than throwing', () => {
    expect(resolveCardImage('rws/not_a_real_card')).toBeNull();
    expect(resolveCardImage('thoth/the_universe')).toBeNull();
  });
});

describe('BUNDLED_DECKS', () => {
  it('includes major_arcana_text and rws in v1', () => {
    const ids = BUNDLED_DECKS.map((d) => d.id);
    expect(ids).toContain('major_arcana_text');
    expect(ids).toContain('rws');
  });

  it('major_arcana_text deck has 22 text-only cards', () => {
    const deck = getDeck('major_arcana_text');
    expect(deck).toBeDefined();
    expect(deck?.cards).toHaveLength(MAJOR_ARCANA_COUNT);
    for (const card of deck?.cards ?? []) {
      expect(card.asset_key).toBeNull();
      expect(card.slug).toMatch(SLUG_PATTERN);
    }
  });

  it('rws deck wraps RWS_CARDS', () => {
    const deck = getDeck('rws');
    expect(deck).toBeDefined();
    expect(deck?.cards).toBe(RWS_CARDS);
  });

  it('every bundled deck uses an id matching the backend pattern', () => {
    for (const deck of BUNDLED_DECKS) {
      expect(deck.id).toMatch(SLUG_PATTERN);
    }
  });
});

describe('getDeck', () => {
  it('returns the rws deck by id', () => {
    expect(getDeck('rws')?.id).toBe('rws');
  });

  it('returns undefined for an unknown deck id', () => {
    expect(getDeck('nonexistent')).toBeUndefined();
  });
});
