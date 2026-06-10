/**
 * Searchable catalogue of "things to notice" for sense-grounding practices.
 *
 * The 5-4-3-2-1 configurator used to expose only the five raw senses as
 * toggle chips. This catalogue widens that to a searchable library of
 * concrete grounding anchors — colours, shapes, textures, sounds, scents,
 * tastes and the classic elements — drawn from the same vocabulary the
 * recipe seeder ships (`backend/src/seed_practice_recipes.py`: Find the
 * Rainbow, Find Shapes, Four Elements …).
 *
 * Every option still resolves to exactly one of the five backend
 * {@link SenseKind} values, so the stored `SenseGroundingConfig` and the
 * 5-4-3-2-1 runtime view keep working unchanged — the catalogue is a
 * richer *picker* over the same data model, never a new one. Users who
 * need something we haven't catalogued create their own entry in the
 * dropdown (label + sense), so the list is a starting point, not a cage.
 */

import type { SenseKind } from '../engine/types';

/** Display name for each backend sense, shown as the option's sense badge. */
export const SENSE_DISPLAY: Readonly<Record<SenseKind, string>> = Object.freeze({
  sight: 'Sight',
  touch: 'Touch',
  hearing: 'Hearing',
  smell: 'Smell',
  taste: 'Taste',
});

/**
 * One pickable anchor. `prompt` is the user-facing line seeded into the
 * step (e.g. "something red"); `label` is the short dropdown caption
 * (e.g. "Red"); `group` is the section header it sorts under.
 */
export interface GroundingOption {
  /** Stable unique id — React key and test handle. */
  readonly id: string;
  /** Short caption shown in the dropdown row. */
  readonly label: string;
  /** Which of the five senses this anchor is noticed through. */
  readonly sense: SenseKind;
  /** Suggested prompt copy seeded into the step when picked. */
  readonly prompt: string;
  /** Section header the option sorts under. */
  readonly group: string;
}

/** Section order for the grouped dropdown render. */
export const GROUNDING_GROUPS = [
  'Senses',
  'Colours',
  'Shapes',
  'Textures',
  'Sounds',
  'Scents',
  'Tastes',
  'Elements',
] as const;

export type GroundingGroup = (typeof GROUNDING_GROUPS)[number];

function option(
  id: string,
  label: string,
  sense: SenseKind,
  prompt: string,
  group: GroundingGroup,
): GroundingOption {
  return { id, label, sense, prompt, group };
}

const SENSE_OPTIONS: readonly GroundingOption[] = [
  option('sense_sight', 'Something to see', 'sight', 'something you can see', 'Senses'),
  option('sense_touch', 'Something to touch', 'touch', 'something you can touch', 'Senses'),
  option('sense_hearing', 'Something to hear', 'hearing', 'something you can hear', 'Senses'),
  option('sense_smell', 'Something to smell', 'smell', 'something you can smell', 'Senses'),
  option('sense_taste', 'Something to taste', 'taste', 'something you can taste', 'Senses'),
];

const COLOUR_OPTIONS: readonly GroundingOption[] = [
  option('colour_red', 'Red', 'sight', 'something red', 'Colours'),
  option('colour_orange', 'Orange', 'sight', 'something orange', 'Colours'),
  option('colour_yellow', 'Yellow', 'sight', 'something yellow', 'Colours'),
  option('colour_green', 'Green', 'sight', 'something green', 'Colours'),
  option('colour_blue', 'Blue', 'sight', 'something blue', 'Colours'),
  option('colour_indigo', 'Indigo', 'sight', 'something indigo', 'Colours'),
  option('colour_violet', 'Violet', 'sight', 'something violet', 'Colours'),
  option('colour_black', 'Black', 'sight', 'something black', 'Colours'),
  option('colour_white', 'White', 'sight', 'something white', 'Colours'),
];

const SHAPE_OPTIONS: readonly GroundingOption[] = [
  option('shape_circle', 'Circle', 'sight', 'a circle', 'Shapes'),
  option('shape_square', 'Square', 'sight', 'a square', 'Shapes'),
  option('shape_triangle', 'Triangle', 'sight', 'a triangle', 'Shapes'),
  option('shape_rectangle', 'Rectangle', 'sight', 'a rectangle', 'Shapes'),
  option('shape_curve', 'Curve', 'sight', 'a curved line', 'Shapes'),
  option('shape_straight', 'Straight line', 'sight', 'a straight line', 'Shapes'),
];

const TEXTURE_OPTIONS: readonly GroundingOption[] = [
  option('texture_smooth', 'Smooth', 'touch', 'a smooth texture', 'Textures'),
  option('texture_rough', 'Rough', 'touch', 'a rough texture', 'Textures'),
  option('texture_soft', 'Soft', 'touch', 'something soft', 'Textures'),
  option('texture_hard', 'Hard', 'touch', 'something hard', 'Textures'),
  option('texture_warm', 'Warm', 'touch', 'something warm', 'Textures'),
  option('texture_cool', 'Cool', 'touch', 'something cool', 'Textures'),
];

const SOUND_OPTIONS: readonly GroundingOption[] = [
  option('sound_far', 'Faraway sound', 'hearing', 'a faraway sound', 'Sounds'),
  option('sound_near', 'Nearby sound', 'hearing', 'a sound close to you', 'Sounds'),
  option('sound_voice', 'A voice', 'hearing', 'a voice', 'Sounds'),
  option('sound_steady', 'A steady hum', 'hearing', 'a steady, continuous sound', 'Sounds'),
  option(
    'sound_quiet',
    'The quietest sound',
    'hearing',
    'the quietest sound you can find',
    'Sounds',
  ),
];

const SCENT_OPTIONS: readonly GroundingOption[] = [
  option('scent_fresh', 'Fresh scent', 'smell', 'something fresh', 'Scents'),
  option('scent_sweet', 'Sweet scent', 'smell', 'something sweet', 'Scents'),
  option('scent_earthy', 'Earthy scent', 'smell', 'something earthy', 'Scents'),
  option('scent_air', 'The air itself', 'smell', 'the smell of the air around you', 'Scents'),
];

const TASTE_OPTIONS: readonly GroundingOption[] = [
  option('taste_sweet', 'Sweet', 'taste', 'something sweet', 'Tastes'),
  option('taste_bitter', 'Bitter', 'taste', 'something bitter', 'Tastes'),
  option('taste_sour', 'Sour', 'taste', 'something sour', 'Tastes'),
  option('taste_mouth', 'Your mouth', 'taste', 'the taste already in your mouth', 'Tastes'),
];

const ELEMENT_OPTIONS: readonly GroundingOption[] = [
  option('element_earth', 'Earth', 'touch', 'the earth element: solidity and weight', 'Elements'),
  option('element_water', 'Water', 'touch', 'the water element: fluidity and moisture', 'Elements'),
  option('element_fire', 'Fire', 'sight', 'the fire element: warmth and light', 'Elements'),
  option('element_air', 'Air', 'touch', 'the air element: movement and breath', 'Elements'),
];

/** The full catalogue, ordered by {@link GROUNDING_GROUPS}. */
export const GROUNDING_CATALOG: readonly GroundingOption[] = Object.freeze([
  ...SENSE_OPTIONS,
  ...COLOUR_OPTIONS,
  ...SHAPE_OPTIONS,
  ...TEXTURE_OPTIONS,
  ...SOUND_OPTIONS,
  ...SCENT_OPTIONS,
  ...TASTE_OPTIONS,
  ...ELEMENT_OPTIONS,
]);

/**
 * Case-insensitive search over an option's label, prompt, group and sense.
 *
 * An empty (or whitespace-only) query returns the whole catalogue so the
 * dropdown shows everything before the user starts typing.
 */
export function searchGroundingCatalog(query: string): readonly GroundingOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return GROUNDING_CATALOG;
  return GROUNDING_CATALOG.filter((opt) =>
    [opt.label, opt.prompt, opt.group, SENSE_DISPLAY[opt.sense]].some((haystack) =>
      haystack.toLowerCase().includes(needle),
    ),
  );
}

/**
 * The catalogue option that exactly matches a stored prompt, if any.
 *
 * A prompt counts as catalogued when both its `sense` and `prompt` copy
 * line up with an option — that lets the dropdown echo "Red" instead of
 * the raw prompt while still treating user-edited copy as custom.
 */
export function findGroundingOption(sense: SenseKind, prompt: string): GroundingOption | undefined {
  return GROUNDING_CATALOG.find((opt) => opt.sense === sense && opt.prompt === prompt);
}
