// Resolves a card asset_key (e.g. "rws/the_fool") to a Metro-bundled image.
//
// Lookup order:
//   1. RWS_IMAGES — the real, per-card bundled artwork. Returned for every
//      shipped key (all 78 cards: 22 Major Arcana + 56 Minor Arcana).
//   2. PLACEHOLDER — defensive fallback for a *known* RWS card whose art is
//      somehow absent, so the full 78-key space resolves to something
//      renderable.
//   3. null — for an unknown key or a text-only card (asset_key === null).

import type { ImageSourcePropType } from 'react-native';

import { RWS_CARDS } from './decks/rws';
import { RWS_IMAGES } from './decks/rwsImages';

// Documented fallback for a known-but-unshipped card. A single static
// require() is all Metro needs; it is never returned for a shipped key.
const PLACEHOLDER = require('../../../../assets/cards/_placeholder.png') as ImageSourcePropType;

// Every asset_key the RWS deck defines (all 78), so we can tell a known card
// awaiting art (→ placeholder) from a genuinely unknown key (→ null).
const KNOWN_RWS_KEYS: ReadonlySet<string> = new Set(RWS_CARDS.map((card) => card.asset_key));

export function resolveCardImage(asset_key: string | null): ImageSourcePropType | null {
  if (asset_key === null) {
    return null;
  }
  const shipped = RWS_IMAGES[asset_key];
  if (shipped !== undefined) {
    return shipped;
  }
  return KNOWN_RWS_KEYS.has(asset_key) ? PLACEHOLDER : null;
}
