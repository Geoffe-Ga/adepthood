/**
 * Microcopy for the guided Metta session launched from the Return arc — the
 * declinable loving-kindness practice offered as a soft landing (NORTH-STAR
 * "you choose your depth").
 *
 * Every line reads like a wise friend sitting beside you, never a verdict.
 * Closing or leaving mid-session costs nothing, so nothing here ranks, shames,
 * or pressures. ``METTA_SESSION_COPY_ENTRIES`` flattens every user-facing
 * string — headings, affordances, and every phrase — for the
 * balance-not-altitude sweep.
 */

import type { ReturnWeek } from '@/api';

/** The idle-screen heading — an invitation into the practice. */
export const METTA_SESSION_HEADING = 'A guided Metta session';

/** The begin affordance label. */
export const METTA_SESSION_BEGIN = 'Begin';

/** The accessibility label for beginning the guided phrases. */
export const METTA_SESSION_BEGIN_A11Y = 'Begin the guided loving-kindness phrases';

/** The advance affordance label. */
export const METTA_SESSION_ADVANCE = 'Next phrase';

/** The accessibility label for advancing to the next phrase. */
export const METTA_SESSION_ADVANCE_A11Y = 'Move to the next phrase';

/** The close affordance label, present in every phase. */
export const METTA_SESSION_CLOSE = 'Close';

/** The accessibility label for closing the session; closing changes nothing. */
export const METTA_SESSION_CLOSE_A11Y = 'Close the session; nothing about your Return changes';

/** The closing rest screen — an open invitation to linger. */
export const METTA_SESSION_REST = 'Rest here for as long as you like.';

/** The outward loving-kindness wish, shared by the benefactor and stranger weeks. */
const TOWARD_ANOTHER: readonly string[] = [
  'May you be safe.',
  'May you be happy.',
  'May you be healthy.',
  'May you be at ease.',
];

/**
 * Loving-kindness phrases adapted to each week's focus. Self turns the wish
 * inward ("May I be…"); every other focus turns it outward ("May you be…"),
 * with the difficult-person week leaning on release rather than fondness.
 */
export const METTA_SESSION_PHRASES: Record<ReturnWeek['focus'], readonly string[]> = {
  self: ['May I be safe.', 'May I be happy.', 'May I be healthy.', 'May I be at ease.'],
  benefactor: TOWARD_ANOTHER,
  stranger: TOWARD_ANOTHER,
  antagonist: [
    'May you be safe.',
    'May you be free from suffering.',
    'May you be at peace.',
    'May you be at ease.',
  ],
  all_beings: [
    'May all beings be safe.',
    'May all beings be happy.',
    'May all beings be healthy.',
    'May all beings be at ease.',
  ],
};

/** Every fixed user-facing string, gathered for the balance-not-altitude sweep. */
const STATIC_ENTRIES: readonly string[] = [
  METTA_SESSION_HEADING,
  METTA_SESSION_BEGIN,
  METTA_SESSION_BEGIN_A11Y,
  METTA_SESSION_ADVANCE,
  METTA_SESSION_ADVANCE_A11Y,
  METTA_SESSION_CLOSE,
  METTA_SESSION_CLOSE_A11Y,
  METTA_SESSION_REST,
];

/** The static strings plus every focus phrase, flattened for the sweep. */
export const METTA_SESSION_COPY_ENTRIES: readonly string[] = [
  ...STATIC_ENTRIES,
  ...Object.values(METTA_SESSION_PHRASES).flat(),
];
