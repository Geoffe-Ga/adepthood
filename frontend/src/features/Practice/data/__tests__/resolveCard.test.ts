/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import type { CardMeditationCard, CardMeditationConfig } from '../../engine/types';
import { getDeck } from '../decks';
import { buildCardMeditationMetadata, pickCard, resolveDeckCards } from '../resolveCard';

const CUSTOM_CARDS: readonly CardMeditationCard[] = [
  { name: 'First', image_asset_key: null, image_uri: 'file:///1.jpg', symbolism: 'one' },
  { name: 'Second', image_asset_key: null, image_uri: 'file:///2.jpg', symbolism: null },
  { name: 'Third', image_asset_key: null, image_uri: null, symbolism: 'three' },
];

function customConfig(over: Partial<CardMeditationConfig> = {}): CardMeditationConfig {
  return { mode: 'card_meditation', deck_id: 'custom', cards: CUSTOM_CARDS, ...over };
}

function bundledConfig(over: Partial<CardMeditationConfig> = {}): CardMeditationConfig {
  return { mode: 'card_meditation', deck_id: 'rws', cards: null, ...over };
}

describe('resolveDeckCards', () => {
  it('returns the inline cards for a custom deck', () => {
    expect(resolveDeckCards(customConfig())).toBe(CUSTOM_CARDS);
  });

  it('returns an empty list for a custom deck with no cards', () => {
    expect(resolveDeckCards(customConfig({ cards: null }))).toEqual([]);
  });

  it('maps a bundled deck manifest to card-meditation cards', () => {
    const resolved = resolveDeckCards(bundledConfig());
    const deck = getDeck('rws');
    expect(deck).toBeDefined();
    expect(resolved).toHaveLength(deck?.cards.length ?? 0);
    expect(resolved[0]?.name).toBe(deck?.cards[0]?.name);
    expect(resolved[0]?.image_asset_key).toBe(deck?.cards[0]?.asset_key);
    expect(resolved[0]?.image_uri).toBeNull();
  });

  it('returns an empty list for an unknown bundled deck', () => {
    expect(resolveDeckCards(bundledConfig({ deck_id: 'nonexistent' }))).toEqual([]);
  });
});

describe('pickCard', () => {
  it('is deterministic for a given seed', () => {
    const config = customConfig();
    const first = pickCard(config, { random: () => 0.5 });
    const second = pickCard(config, { random: () => 0.5 });
    expect(first).toEqual(second);
    expect(first.card.name).toBe('Second');
    expect(first.index).toBe(1);
  });

  it('draws different cards for different seeds', () => {
    const config = customConfig();
    expect(pickCard(config, { random: () => 0 }).card.name).toBe('First');
    expect(pickCard(config, { random: () => 0.99 }).card.name).toBe('Third');
  });

  it('clamps the draw when the RNG yields its 1.0 edge', () => {
    const picked = pickCard(customConfig(), { random: () => 1 });
    expect(picked.index).toBe(CUSTOM_CARDS.length - 1);
  });

  it('draws the first card when shuffle is off', () => {
    const picked = pickCard(customConfig({ shuffle: false }), { random: () => 0.9 });
    expect(picked.index).toBe(0);
    expect(picked.card.name).toBe('First');
  });

  it('draws from the inline cards override for a custom deck', () => {
    const picked = pickCard(customConfig({ shuffle: false }));
    expect(CUSTOM_CARDS).toContainEqual(picked.card);
  });

  it('draws from the bundled deck when the override is null', () => {
    const picked = pickCard(bundledConfig({ shuffle: false }));
    const deck = getDeck('rws');
    expect(picked.card.name).toBe(deck?.cards[0]?.name);
    expect(picked.index).toBe(0);
  });

  it('caches the draw per config object so re-renders never reshuffle', () => {
    const config = bundledConfig();
    expect(pickCard(config)).toBe(pickCard(config));
  });

  it('falls back to a text-only card for an unknown deck', () => {
    const picked = pickCard(bundledConfig({ deck_id: 'gone' }));
    expect(picked.index).toBeNull();
    expect(picked.card.image_asset_key).toBeNull();
    expect(picked.card.image_uri).toBeNull();
  });
});

describe('buildCardMeditationMetadata', () => {
  it('records the drawn card name, deck id, and index', () => {
    const config = customConfig();
    const metadata = buildCardMeditationMetadata(config, { card: CUSTOM_CARDS[1]!, index: 1 });
    expect(metadata).toEqual({
      mode: 'card_meditation',
      deck_id: 'custom',
      card_drawn_name: 'Second',
      card_drawn_index: 1,
    });
  });

  it('omits the index when the draw cannot be positioned', () => {
    const metadata = buildCardMeditationMetadata(bundledConfig({ deck_id: 'gone' }), {
      card: { name: 'Card', image_asset_key: null, image_uri: null, symbolism: null },
      index: null,
    });
    expect(metadata.card_drawn_index).toBeUndefined();
    expect(metadata.card_drawn_name).toBe('Card');
  });
});
