/**
 * Resolve a card ``asset_key`` (e.g. ``rws/the_fool``) to a bundled
 * ``ImageSourcePropType`` Metro can render via ``<Image source={...} />``.
 *
 * Metro statically analyses ``require()`` calls at bundle time and
 * refuses dynamic paths — so the per-card image map *must* be a literal
 * table of static ``require()`` calls. Until real card art ships, every
 * RWS card resolves to the bundled placeholder; the table below holds
 * one ``require()`` for the placeholder and points every key at it.
 *
 * When real images land (one batch per suit is fine), the migration is
 * mechanical:
 *
 *   1. Drop image files into ``frontend/assets/cards/rws/`` using the
 *      slug-derived filenames documented in
 *      ``frontend/assets/cards/README.md``.
 *   2. Replace ``PLACEHOLDER`` on a card-by-card basis with a per-card
 *      ``require('../../../../assets/cards/rws/<slug>.jpg')``.
 *
 * ``resolveCardImage(null)`` returns ``null`` so callers can branch on
 * "this card is text-only" without a separate flag. An unknown
 * ``asset_key`` also returns ``null`` rather than throwing — a missing
 * image must not crash the practice session.
 */

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
