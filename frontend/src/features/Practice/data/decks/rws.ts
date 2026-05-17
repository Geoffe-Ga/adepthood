/**
 * Rider-Waite-Smith deck content for the ``card_meditation`` practice mode.
 *
 * The full 78 cards (22 major arcana + 14 cards × 4 suits) are encoded
 * here as read-only metadata. Each card carries:
 *
 *   - ``slug`` — snake_case identifier matching ``^[a-z][a-z0-9_]*$``;
 *     used to compose ``asset_key`` and as a stable key for any UI list.
 *   - ``name`` — human-facing title rendered above the card image.
 *   - ``keyword`` — one-to-three-word reflection seed (≤ 24 chars).
 *   - ``symbolism`` — single-sentence prompt (≤ 90 chars) to ground the
 *     meditation when the user is unfamiliar with the card.
 *   - ``asset_key`` — opaque handle of the form ``rws/<slug>`` that
 *     ``resolveCardImage`` maps to a bundled image asset. The backend
 *     stores this string verbatim (see
 *     ``backend/src/schemas/practice_mode_config.py::CardMeditationCard``)
 *     and never dereferences it.
 *
 * Until real card art ships, every ``asset_key`` resolves to the bundled
 * ``_placeholder.png`` — the bundler is happy and the layout is testable.
 * See ``frontend/assets/cards/README.md`` for image-drop instructions.
 */

import type { CardMeta } from './index';

const DECK_ID = 'rws';

/**
 * ``CardMeta`` with a non-nullable ``asset_key``. The RWS deck always
 * ships images (placeholder today, real art tomorrow), so the resolver
 * can rely on this tighter shape — it stays assignable to ``CardMeta``
 * because ``string`` narrows ``string | null``.
 */
export type RwsCardMeta = CardMeta & { readonly asset_key: string };

type CardRow = readonly [slug: string, name: string, keyword: string, symbolism: string];

const MAJOR_ARCANA_ROWS: readonly CardRow[] = [
  [
    'the_fool',
    'The Fool',
    'Beginnings',
    'Stepping off the cliff with open eyes and an open heart.',
  ],
  [
    'the_magician',
    'The Magician',
    'Manifestation',
    'Channelling will into form; tools of every element to hand.',
  ],
  [
    'the_high_priestess',
    'The High Priestess',
    'Intuition',
    'The veiled gate between the seen and the felt.',
  ],
  [
    'the_empress',
    'The Empress',
    'Abundance',
    'Fertile garden, ripening, the body as a place to belong.',
  ],
  [
    'the_emperor',
    'The Emperor',
    'Structure',
    'Throne of stone — order, boundary, the limits that protect.',
  ],
  [
    'the_hierophant',
    'The Hierophant',
    'Tradition',
    'The keeper of inherited keys; teacher, lineage, vow.',
  ],
  ['the_lovers', 'The Lovers', 'Choice', 'Two paths converge; the heart speaks before the mind.'],
  ['the_chariot', 'The Chariot', 'Will', 'Reins held in tension — two beasts moving as one.'],
  ['strength', 'Strength', 'Gentle power', 'A woman closing the lion’s jaws with a soft hand.'],
  [
    'the_hermit',
    'The Hermit',
    'Solitude',
    'Lantern raised on the mountain path; light made for one.',
  ],
  [
    'wheel_of_fortune',
    'Wheel of Fortune',
    'Turning',
    'Cycles within cycles; what rose will fall, what fell will rise.',
  ],
  ['justice', 'Justice', 'Truth', 'Sword and scales — clear sight, fair weight, honest cut.'],
  [
    'the_hanged_man',
    'The Hanged Man',
    'Surrender',
    'Suspended upside-down; the view changes when struggle stops.',
  ],
  ['death', 'Death', 'Release', 'The threshold; what is finished, allowed to be finished.'],
  [
    'temperance',
    'Temperance',
    'Blending',
    'Water poured between two cups without spill — middle way.',
  ],
  ['the_devil', 'The Devil', 'Shadow', 'Chains loose enough to slip; the bondage we agree to.'],
  [
    'the_tower',
    'The Tower',
    'Rupture',
    'Lightning splits the false structure; rubble before renewal.',
  ],
  ['the_star', 'The Star', 'Hope', 'Naked under the night sky, pouring water on parched earth.'],
  ['the_moon', 'The Moon', 'Mystery', 'Tides, dreams, and the long path between the towers.'],
  ['the_sun', 'The Sun', 'Joy', 'Child on horseback in a garden — uncomplicated gladness.'],
  [
    'judgement',
    'Judgement',
    'Awakening',
    'The trumpet calls; the buried rise into their own names.',
  ],
  [
    'the_world',
    'The World',
    'Completion',
    'The dance finished; the circle closes and opens again.',
  ],
];

interface SuitMeta {
  readonly slug: string;
  readonly display: string;
  readonly element: string;
}

const SUITS: readonly SuitMeta[] = [
  { slug: 'wands', display: 'Wands', element: 'fire' },
  { slug: 'cups', display: 'Cups', element: 'water' },
  { slug: 'swords', display: 'Swords', element: 'air' },
  { slug: 'pentacles', display: 'Pentacles', element: 'earth' },
];

interface RankMeta {
  readonly slug: string;
  readonly display: string;
  readonly keyword: string;
  readonly arc: string;
}

const RANKS: readonly RankMeta[] = [
  { slug: 'ace', display: 'Ace', keyword: 'Seed', arc: 'pure essence of the suit' },
  { slug: 'two', display: 'Two', keyword: 'Pairing', arc: 'first encounter, balance' },
  { slug: 'three', display: 'Three', keyword: 'Emergence', arc: 'creation taking shape' },
  { slug: 'four', display: 'Four', keyword: 'Stability', arc: 'foundation laid, pause' },
  { slug: 'five', display: 'Five', keyword: 'Disruption', arc: 'tension, loss, friction' },
  { slug: 'six', display: 'Six', keyword: 'Recovery', arc: 'movement after struggle' },
  { slug: 'seven', display: 'Seven', keyword: 'Assessment', arc: 'inward weighing of paths' },
  { slug: 'eight', display: 'Eight', keyword: 'Mastery', arc: 'craft refined through repetition' },
  { slug: 'nine', display: 'Nine', keyword: 'Fulfilment', arc: 'near-completion, the gift' },
  { slug: 'ten', display: 'Ten', keyword: 'Culmination', arc: 'full cycle, what comes next' },
  { slug: 'page', display: 'Page', keyword: 'Student', arc: 'curious apprentice of the suit' },
  { slug: 'knight', display: 'Knight', keyword: 'Quest', arc: 'embodied pursuit, momentum' },
  { slug: 'queen', display: 'Queen', keyword: 'Embodiment', arc: 'inward sovereignty of the suit' },
  { slug: 'king', display: 'King', keyword: 'Authority', arc: 'outward mastery of the suit' },
];

function toCard([slug, name, keyword, symbolism]: CardRow): RwsCardMeta {
  return { slug, name, keyword, symbolism, asset_key: `${DECK_ID}/${slug}` };
}

function minorArcanaRows(): readonly CardRow[] {
  const rows: CardRow[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      rows.push([
        `${rank.slug}_of_${suit.slug}`,
        `${rank.display} of ${suit.display}`,
        rank.keyword,
        `${rank.arc} — ${suit.element}.`,
      ]);
    }
  }
  return rows;
}

export const RWS_CARDS: readonly RwsCardMeta[] = [...MAJOR_ARCANA_ROWS, ...minorArcanaRows()].map(
  toCard,
);
