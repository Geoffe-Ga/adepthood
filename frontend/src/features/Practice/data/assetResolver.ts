// Resolves a card asset_key (e.g. "rws/the_fool") to a Metro-bundled image; null for text-only/unknown keys.

import type { ImageSourcePropType } from 'react-native';

import { RWS_CARDS } from './decks/rws';

// Single static require() satisfies Metro and gives us one symbol to
// reuse 78 times below. Replace per-card with real artwork over time.
const PLACEHOLDER = require('../../../../assets/cards/_placeholder.png') as ImageSourcePropType;

function buildRwsImageMap(): ReadonlyMap<string, ImageSourcePropType> {
  // ``RwsCardMeta`` guarantees ``asset_key`` is a string — no narrowing needed.
  return new Map(RWS_CARDS.map((card) => [card.asset_key, PLACEHOLDER]));
}

const CARD_IMAGES: ReadonlyMap<string, ImageSourcePropType> = buildRwsImageMap();

export function resolveCardImage(asset_key: string | null): ImageSourcePropType | null {
  if (asset_key === null) {
    return null;
  }
  return CARD_IMAGES.get(asset_key) ?? null;
}
