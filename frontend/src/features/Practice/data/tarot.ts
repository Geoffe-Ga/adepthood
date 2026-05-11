/**
 * Major arcana data + day-index resolver for the tarot meditation preset.
 *
 * The deck is 22 cards in the traditional Marseille / RWS order; the cycle
 * wraps every 22 days so `cardForDayIndex` is a pure modulo lookup. The
 * caller — `PracticeScreen` in ritual-11 — is responsible for computing
 * `daysSinceStart` from `UserPractice.start_date` and the user's local
 * timezone before calling this helper.
 *
 * Keywords and symbolism strings are deliberately short (≤ 80 chars) so the
 * view can render them inline without truncation across phone widths. No
 * image assets ship in this issue; the view renders the card name plus a
 * stylised border. A follow-up asset task can layer illustrations on top
 * once licensing for a deck has been sorted.
 */

import { TAROT_DECK_SIZE } from '../engine/types';

export interface TarotCard {
  readonly index: number;
  readonly name: string;
  readonly keyword: string;
  readonly symbolism: string;
}

export const MAJOR_ARCANA: readonly TarotCard[] = [
  {
    index: 0,
    name: 'The Fool',
    keyword: 'Beginnings',
    symbolism: 'Stepping off the cliff with open eyes and an open heart.',
  },
  {
    index: 1,
    name: 'The Magician',
    keyword: 'Manifestation',
    symbolism: 'Channelling will into form; tools of every element to hand.',
  },
  {
    index: 2,
    name: 'The High Priestess',
    keyword: 'Intuition',
    symbolism: 'The veiled gate between the seen and the felt.',
  },
  {
    index: 3,
    name: 'The Empress',
    keyword: 'Abundance',
    symbolism: 'Fertile garden, ripening, the body as a place to belong.',
  },
  {
    index: 4,
    name: 'The Emperor',
    keyword: 'Structure',
    symbolism: 'Throne of stone — order, boundary, the limits that protect.',
  },
  {
    index: 5,
    name: 'The Hierophant',
    keyword: 'Tradition',
    symbolism: 'The keeper of inherited keys; teacher, lineage, vow.',
  },
  {
    index: 6,
    name: 'The Lovers',
    keyword: 'Choice',
    symbolism: 'Two paths converge; the heart speaks before the mind.',
  },
  {
    index: 7,
    name: 'The Chariot',
    keyword: 'Will',
    symbolism: 'Reins held in tension — two beasts moving as one.',
  },
  {
    index: 8,
    name: 'Strength',
    keyword: 'Gentle power',
    symbolism: 'A woman closing the lion’s jaws with a soft hand.',
  },
  {
    index: 9,
    name: 'The Hermit',
    keyword: 'Solitude',
    symbolism: 'Lantern raised on the mountain path; light made for one.',
  },
  {
    index: 10,
    name: 'Wheel of Fortune',
    keyword: 'Turning',
    symbolism: 'Cycles within cycles; what rose will fall, what fell will rise.',
  },
  {
    index: 11,
    name: 'Justice',
    keyword: 'Truth',
    symbolism: 'Sword and scales — clear sight, fair weight, honest cut.',
  },
  {
    index: 12,
    name: 'The Hanged Man',
    keyword: 'Surrender',
    symbolism: 'Suspended upside-down; the view changes when struggle stops.',
  },
  {
    index: 13,
    name: 'Death',
    keyword: 'Release',
    symbolism: 'The threshold; what is finished, allowed to be finished.',
  },
  {
    index: 14,
    name: 'Temperance',
    keyword: 'Blending',
    symbolism: 'Water poured between two cups without spill — middle way.',
  },
  {
    index: 15,
    name: 'The Devil',
    keyword: 'Shadow',
    symbolism: 'Chains loose enough to slip; the bondage we agree to.',
  },
  {
    index: 16,
    name: 'The Tower',
    keyword: 'Rupture',
    symbolism: 'Lightning splits the false structure; rubble before renewal.',
  },
  {
    index: 17,
    name: 'The Star',
    keyword: 'Hope',
    symbolism: 'Naked under the night sky, pouring water on parched earth.',
  },
  {
    index: 18,
    name: 'The Moon',
    keyword: 'Mystery',
    symbolism: 'Tides, dreams, and the long path between the towers.',
  },
  {
    index: 19,
    name: 'The Sun',
    keyword: 'Joy',
    symbolism: 'Child on horseback in a garden — uncomplicated gladness.',
  },
  {
    index: 20,
    name: 'Judgement',
    keyword: 'Awakening',
    symbolism: 'The trumpet calls; the buried rise into their own names.',
  },
  {
    index: 21,
    name: 'The World',
    keyword: 'Completion',
    symbolism: 'The dance finished; the circle closes and opens again.',
  },
];

/**
 * Resolve a day offset (0-based; day 0 is the user's first day) to a card.
 *
 * The cycle wraps modulo {@link TAROT_DECK_SIZE}, so day 22 returns the
 * Fool again. Callers should pre-clamp pre-start days to 0; negative
 * inputs are nonetheless guarded by the double-modulo expression below
 * (JavaScript's `%` returns a negative result for negative operands, so
 * a single `% SIZE` would leak `-1`).
 */
export function cardForDayIndex(daysSinceStart: number): TarotCard {
  const normalised = ((daysSinceStart % TAROT_DECK_SIZE) + TAROT_DECK_SIZE) % TAROT_DECK_SIZE;
  const card = MAJOR_ARCANA[normalised];
  if (!card) {
    // Unreachable: MAJOR_ARCANA has TAROT_DECK_SIZE entries and `normalised`
    // is in [0, TAROT_DECK_SIZE). Keep the explicit guard so the return type
    // is `TarotCard` rather than `TarotCard | undefined`.
    throw new Error(`tarot: no card at normalised index ${normalised}`);
  }
  return card;
}
