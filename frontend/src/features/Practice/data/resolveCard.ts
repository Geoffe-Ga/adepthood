// Resolves a `CardMeditationConfig` to the single card drawn for a session.

import type { CardMeditationCard, CardMeditationConfig } from '../engine/types';
import { CARD_MEDITATION_CUSTOM_DECK_ID } from '../engine/types';

import type { CardMeta } from './decks';
import { getDeck } from './decks';

import type { CardMeditationSessionMetadata } from '@/api';

/** The card drawn for a session plus its canonical (pre-shuffle) deck index. */
export interface PickedCard {
  readonly card: CardMeditationCard;
  /** Zero-based index in the canonical deck order; `null` when the deck is empty/unknown. */
  readonly index: number | null;
}

/** Injectable RNG for deterministic tests; production callers omit it. */
export interface PickCardDeps {
  readonly random?: () => number;
}

/** Graceful fallback when a config points at an unknown or empty deck. */
const FALLBACK_CARD: CardMeditationCard = {
  name: 'Card',
  image_asset_key: null,
  image_uri: null,
  symbolism: null,
};

function metaToCard(meta: CardMeta): CardMeditationCard {
  return {
    name: meta.name,
    image_asset_key: meta.asset_key,
    image_uri: null,
    symbolism: meta.symbolism,
  };
}

/**
 * The canonical, pre-shuffle card list for a config: the inline `cards`
 * for a custom deck, or the bundled deck's manifest otherwise. An unknown
 * `deck_id` yields an empty list rather than throwing.
 */
export function resolveDeckCards(config: CardMeditationConfig): readonly CardMeditationCard[] {
  if (config.deck_id === CARD_MEDITATION_CUSTOM_DECK_ID) {
    return config.cards ?? [];
  }
  const deck = getDeck(config.deck_id);
  return deck ? deck.cards.map(metaToCard) : [];
}

// A session draws its card once; a WeakMap keyed on the config object keeps
// the draw idempotent across re-renders (the same config reference always
// resolves to the same card) without leaking between sessions — a
// configurator save produces a fresh config object and thus a fresh draw.
const pickCache = new WeakMap<CardMeditationConfig, PickedCard>();

/**
 * Draw a single card for a session.
 *
 * `shuffle` (default on) draws a uniformly random card; with `shuffle`
 * off the first card of the deck is drawn. The result is cached per
 * config object so re-renders never reshuffle. Passing an explicit
 * `random` bypasses the cache, which keeps shuffle deterministic in tests.
 */
export function pickCard(config: CardMeditationConfig, deps: PickCardDeps = {}): PickedCard {
  const cached = pickCache.get(config);
  if (cached !== undefined && deps.random === undefined) {
    return cached;
  }
  const cards = resolveDeckCards(config);
  const picked = drawCard(config, cards, deps.random ?? Math.random);
  if (deps.random === undefined) {
    pickCache.set(config, picked);
  }
  return picked;
}

function drawCard(
  config: CardMeditationConfig,
  cards: readonly CardMeditationCard[],
  random: () => number,
): PickedCard {
  if (cards.length === 0) {
    return { card: FALLBACK_CARD, index: null };
  }
  const shuffle = config.shuffle ?? true;
  // `random()` is in [0, 1); the `min` guards the theoretical 1.0 edge.
  const index = shuffle ? Math.min(cards.length - 1, Math.floor(random() * cards.length)) : 0;
  return { card: cards[index]!, index };
}

/** Build the wire metadata recording which card the session drew. */
export function buildCardMeditationMetadata(
  config: CardMeditationConfig,
  picked: PickedCard,
): CardMeditationSessionMetadata {
  const metadata: CardMeditationSessionMetadata = {
    mode: 'card_meditation',
    deck_id: config.deck_id,
    card_drawn_name: picked.card.name,
  };
  return picked.index === null ? metadata : { ...metadata, card_drawn_index: picked.index };
}
