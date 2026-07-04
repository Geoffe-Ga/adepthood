// Rider-Waite-Smith deck content (78 cards) for the card_meditation practice mode.

import { MAJOR_ARCANA } from '../tarot';

import type { CardMeta } from './index';

const DECK_ID = 'rws';

/** `CardMeta` with a non-nullable `asset_key` — the RWS deck always ships images. */
export type RwsCardMeta = CardMeta & { readonly asset_key: string };

type CardRow = readonly [slug: string, name: string, keyword: string, symbolism: string];

/** Derive a card slug from its display name; shared with the major_arcana_text deck. */
export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
}

// Major arcana derive from the canonical MAJOR_ARCANA (tarot.ts) so the two decks cannot drift.
const MAJOR_ARCANA_ROWS: readonly CardRow[] = MAJOR_ARCANA.map((card): CardRow => [
  deriveSlug(card.name),
  card.name,
  card.keyword,
  card.symbolism,
]);

const SUITS = [
  { slug: 'wands', display: 'Wands' },
  { slug: 'cups', display: 'Cups' },
  { slug: 'swords', display: 'Swords' },
  { slug: 'pentacles', display: 'Pentacles' },
] as const;

const RANKS = [
  { slug: 'ace', display: 'Ace', keyword: 'Seed' },
  { slug: 'two', display: 'Two', keyword: 'Pairing' },
  { slug: 'three', display: 'Three', keyword: 'Emergence' },
  { slug: 'four', display: 'Four', keyword: 'Stability' },
  { slug: 'five', display: 'Five', keyword: 'Disruption' },
  { slug: 'six', display: 'Six', keyword: 'Recovery' },
  { slug: 'seven', display: 'Seven', keyword: 'Assessment' },
  { slug: 'eight', display: 'Eight', keyword: 'Mastery' },
  { slug: 'nine', display: 'Nine', keyword: 'Fulfilment' },
  { slug: 'ten', display: 'Ten', keyword: 'Culmination' },
  { slug: 'page', display: 'Page', keyword: 'Student' },
  { slug: 'knight', display: 'Knight', keyword: 'Quest' },
  { slug: 'queen', display: 'Queen', keyword: 'Embodiment' },
  { slug: 'king', display: 'King', keyword: 'Authority' },
] as const;

type SuitSlug = (typeof SUITS)[number]['slug'];
type RankSlug = (typeof RANKS)[number]['slug'];
type MinorSlug = `${RankSlug}_of_${SuitSlug}`;

// Minor-arcana symbolism from Waite's "Pictorial Key to the Tarot"; surfaced only after the sit.
const MINOR_SYMBOLISM: Record<MinorSlug, string> = {
  ace_of_wands: 'A hand from the cloud offers a sprouting wand; the spark before any fire.',
  two_of_wands: 'On the battlement he holds a globe, gazing past the land and sea he owns.',
  three_of_wands: 'From the cliff he watches his ships sail out; the venture already under way.',
  four_of_wands: 'Four staves bear a flower-garland; the open gate of welcome and first harvest.',
  five_of_wands:
    'Five youths brandish staves in a scramble — striving half in play, half in earnest.',
  six_of_wands: 'A laurel-crowned rider returns among the crowd; victory openly acknowledged.',
  seven_of_wands: 'He keeps the higher ground, one staff braced against six raised from below.',
  eight_of_wands: 'Eight staves fly level over open country — swift motion, the haste of arrows.',
  nine_of_wands: 'Bandaged but upright, he leans on a staff with eight ranged like a fence behind.',
  ten_of_wands: 'Bowed under all ten staves, the town in sight — the weight of what was won.',
  page_of_wands: 'A youth in the desert studies a flowering staff — the first stir of an idea.',
  knight_of_wands:
    'Armoured on a rearing horse, salamanders on his coat — the headlong rush of fire.',
  queen_of_wands:
    'Enthroned with sunflower and black cat — warmth that is also fierce and self-possessed.',
  king_of_wands:
    'A throne of lions and salamanders; the wand held steady — will that governs flame.',
  ace_of_cups:
    'A dove lowers the host to a chalice brimming over — the heart’s cup, freely filled.',
  two_of_cups: 'Two pledge their cups beneath the winged lion’s head — a meeting met as equals.',
  three_of_cups:
    'Three women circle with cups raised among the fruit — shared gladness, the toast.',
  four_of_cups: 'Arms folded under the tree, he overlooks the cup a cloud holds out to him.',
  five_of_cups:
    'Cloaked above three spilled cups, he has not yet turned to the two still standing.',
  six_of_cups: 'A child offers a cup of flowers in the old courtyard — memory and innocent giving.',
  seven_of_cups: 'Seven cups rise in cloud, each holding a vision — the dream not yet chosen.',
  eight_of_cups:
    'He turns from eight stacked cups and walks to the hills beneath an eclipsed moon.',
  nine_of_cups: 'Seated content before nine cups ranged on their arch — the wish already granted.',
  ten_of_cups: 'Ten cups arc as a rainbow above the family and home — the whole heart at peace.',
  page_of_cups:
    'A youth lifts his cup and a fish looks back — the odd message of the feeling-self.',
  knight_of_cups:
    'Riding slow with the cup held out, winged at helm and heel — the bearer of an offer.',
  queen_of_cups:
    'On a throne at the water’s edge she gazes into a closed cup — feeling turned inward.',
  king_of_cups:
    'His throne rides a tossing sea, the cup held level — feeling steadied, not stilled.',
  ace_of_swords: 'A hand grips one upright sword crowned with a wreath — the first clean truth.',
  two_of_swords: 'Blindfolded, two swords crossed at her breast — a truce kept by not looking.',
  three_of_swords:
    'Three swords pierce a single heart under grey rain — the clean wound of sorrow.',
  four_of_swords:
    'A knight lies in stone repose, three swords above and one below — the truce of rest.',
  five_of_swords: 'He gathers the swords as two others walk away — the win that costs the field.',
  six_of_swords: 'A boat of six swords is poled toward a calmer shore — passage to quieter water.',
  seven_of_swords:
    'He slips from the camp with five swords, two left behind — the lone, sly scheme.',
  eight_of_swords:
    'Bound and blindfold among eight planted swords — the cage that is not quite shut.',
  nine_of_swords: 'She sits up in the dark, nine swords on the wall — the long night of the mind.',
  ten_of_swords:
    'Ten swords in a fallen back, yet dawn breaks on the skyline — the worst, then its end.',
  page_of_swords:
    'On windswept ground, sword raised, he watches — vigilance, the keen restless mind.',
  knight_of_swords:
    'Full gallop into a torn sky, sword held high — thought rushing ahead of itself.',
  queen_of_swords:
    'Enthroned above the clouds, sword upright, one hand open — sight earned through loss.',
  king_of_swords:
    'The sword stands upright and faintly tilted — judgement, the law spoken plainly.',
  ace_of_pentacles:
    'A hand offers one pentacle above a garden gate — the solid chance, freshly given.',
  two_of_pentacles:
    'He dances juggling two coins in a looping band while ships ride the swell behind.',
  three_of_pentacles:
    'A mason works in the arch as two consult his plan — skill seen, the shared build.',
  four_of_pentacles:
    'He clutches one coin, two beneath his feet, one on his head — holding so tight.',
  five_of_pentacles:
    'Two destitute figures pass a lit church window in the snow — want, and unseen warmth.',
  six_of_pentacles:
    'Coins weighed on the scale, alms to the kneeling — giving, and the question of measure.',
  seven_of_pentacles:
    'He leans on his hoe to study seven coins on the vine — the pause to weigh the growth.',
  eight_of_pentacles:
    'At the bench he carves one coin after another — patient craft, the work repeated.',
  nine_of_pentacles:
    'In her own vineyard, a hooded falcon at her wrist — the ease of earned solitude.',
  ten_of_pentacles:
    'Elder, dogs and family beneath an arch of ten coins — wealth that outlasts a life.',
  page_of_pentacles:
    'A youth in the field studies a coin held in both hands — the apprentice of slow gain.',
  knight_of_pentacles:
    'Still on a heavy horse above the ploughed field — slow, sure, unshowy progress.',
  queen_of_pentacles:
    'In a flowering bower, a coin cradled in her lap — nurture rooted in body and earth.',
  king_of_pentacles:
    'Enthroned among the grapevines, a coin upon his knee — the steady, well-held estate.',
};

function toCard([slug, name, keyword, symbolism]: CardRow): RwsCardMeta {
  return { slug, name, keyword, symbolism, asset_key: `${DECK_ID}/${slug}` };
}

function minorArcanaRows(): readonly CardRow[] {
  const rows: CardRow[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const slug = `${rank.slug}_of_${suit.slug}` as const;
      rows.push([slug, `${rank.display} of ${suit.display}`, rank.keyword, MINOR_SYMBOLISM[slug]]);
    }
  }
  return rows;
}

export const RWS_CARDS: readonly RwsCardMeta[] = [...MAJOR_ARCANA_ROWS, ...minorArcanaRows()].map(
  toCard,
);
