// Bundled-deck manifest for the card_meditation practice mode (v1: major_arcana_text + rws).

import { MAJOR_ARCANA } from '../tarot';

import { deriveSlug, RWS_CARDS } from './rws';

export interface CardMeta {
  /** Snake_case identifier matching ``^[a-z][a-z0-9_]*$``; stable across renames. */
  readonly slug: string;
  /** Human-facing card title rendered above the image / symbolism block. */
  readonly name: string;
  /** One-to-three-word reflection seed; ≤ 24 chars to fit narrow phones. */
  readonly keyword: string;
  /** One-sentence symbolism note (≤ 90 chars); revealed only after the sit, never before — the card must meet the user unprimed. */
  readonly symbolism: string;
  /**
   * Opaque handle of the form ``<deck_id>/<slug>`` resolved by
   * ``resolveCardImage``. ``null`` means the card is text-only (the
   * legacy ``major_arcana_text`` deck).
   */
  readonly asset_key: string | null;
}

export interface DeckMeta {
  /** Slug matching ``^[a-z][a-z0-9_]*$`` and the backend's ``CARD_DECK_ID_PATTERN``. */
  readonly id: string;
  /** Human-facing deck title shown in the deck-picker. */
  readonly name: string;
  /** One-line dev-friendly description. */
  readonly description: string;
  /** Read-only card list; bundled decks own the canonical order. */
  readonly cards: readonly CardMeta[];
}

function majorArcanaTextCards(): readonly CardMeta[] {
  return MAJOR_ARCANA.map((card) => ({
    slug: deriveSlug(card.name),
    name: card.name,
    keyword: card.keyword,
    symbolism: card.symbolism,
    asset_key: null,
  }));
}

const MAJOR_ARCANA_TEXT_DECK: DeckMeta = {
  id: 'major_arcana_text',
  name: 'Major Arcana (text only)',
  description: 'The 22 trumps with keywords and symbolism — no card images.',
  cards: majorArcanaTextCards(),
};

const RWS_DECK: DeckMeta = {
  id: 'rws',
  name: 'Rider-Waite-Smith',
  description: 'Full 78-card RWS deck (22 major arcana + 14 cards × 4 suits).',
  cards: RWS_CARDS,
};

export const BUNDLED_DECKS: readonly DeckMeta[] = [MAJOR_ARCANA_TEXT_DECK, RWS_DECK];

export function getDeck(id: string): DeckMeta | undefined {
  return BUNDLED_DECKS.find((deck) => deck.id === id);
}
