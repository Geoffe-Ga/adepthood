/**
 * The Map's stage vocabulary as it reads today, pinned literally (#2666).
 *
 * Every line here is copy a traveller sees or a screen reader speaks: each
 * stage's persona, descriptor and arrow label, the two title watermarks, the six
 * right-column categories with their hyphenated fallback lines, the lens's
 * spoken identity, the drawer row and the Journal chord chip. It was captured
 * from the static mirrors before #2666 moved that copy onto the server's
 * `GET /stages` data, and the golden suites that read it stay byte-identical
 * across the move: the migration is a change of source, not of words.
 *
 * `CANON_STAGE_OVERRIDES` is the server's side of the same words -- the four
 * `StageData` fields the vocabulary derives from, as `GET /stages` serves them
 * for a freshly seeded database. `stageVocabulary.test.ts` holds it to the
 * backend's own sources through `@/testing/backendSource`, so this fixture
 * cannot drift from the seed without a red test.
 */
import type { StageData } from '../stageData';

import { mockMakeStage } from './mapTestHarness';

/** The vocabulary of one stage, as the Map and the chord render it. */
export interface GoldenStage {
  persona: string;
  descriptor: string;
  /** The arrow-loop word; '' for the two title stages. */
  arrowLabel: string;
  /** The UNITY / EMPTINESS watermark of a title stage; undefined below it. */
  watermark: string | undefined;
  /** The right-column category of the row the stage sits in. */
  category: string;
  /** The lens's spoken identity for this stage. */
  lensIdentity: string;
}

/** One right-column row: its category and the lines it falls back to. */
export interface GoldenRow {
  category: string;
  fallbackLines: readonly string[];
  stageNumbers: readonly number[];
}

export const GOLDEN_STAGES: Readonly<Record<number, GoldenStage>> = {
  1: {
    persona: 'Biological Machine',
    descriptor: 'Survival',
    arrowLabel: 'Agency',
    watermark: undefined,
    category: 'Yes-And-Ness',
    lensIdentity: 'Agency, stage 1 · BEIGE, Biological Machine',
  },
  2: {
    persona: 'Pleasure Seeker',
    descriptor: 'Magick',
    arrowLabel: 'Receptivity',
    watermark: undefined,
    category: 'Yes-And-Ness',
    lensIdentity: 'Receptivity, stage 2 · PURPLE, Pleasure Seeker',
  },
  3: {
    persona: 'Dominator',
    descriptor: 'Power',
    arrowLabel: 'Self-Love',
    watermark: undefined,
    category: 'Love',
    lensIdentity: 'Self-Love, stage 3 · RED, Dominator',
  },
  4: {
    persona: 'Victim',
    descriptor: 'Conformity',
    arrowLabel: 'Community',
    watermark: undefined,
    category: 'Love',
    lensIdentity: 'Community, stage 4 · BLUE, Victim',
  },
  5: {
    persona: 'Status Seeker',
    descriptor: 'Achievist',
    arrowLabel: 'Intellectual',
    watermark: undefined,
    category: 'Understanding',
    lensIdentity: 'Intellectual, stage 5 · ORANGE, Status Seeker',
  },
  6: {
    persona: 'Shadow Glorifier',
    descriptor: 'Pluralist',
    arrowLabel: 'Embodied',
    watermark: undefined,
    category: 'Understanding',
    lensIdentity: 'Embodied, stage 6 · GREEN, Shadow Glorifier',
  },
  7: {
    persona: 'Despairing Analyst',
    descriptor: 'Integrative',
    arrowLabel: 'Systems',
    watermark: undefined,
    category: 'Wisdom',
    lensIdentity: 'Systems, stage 7 · YELLOW, Despairing Analyst',
  },
  8: {
    persona: 'True Self Embodier',
    descriptor: 'True Self Connection',
    arrowLabel: 'True Self',
    watermark: undefined,
    category: 'Wisdom',
    lensIdentity: 'True Self, stage 8 · TEAL, True Self Embodier',
  },
  9: {
    persona: 'Blissy Adept',
    descriptor: 'Effortless Being',
    arrowLabel: '',
    watermark: 'UNITY',
    category: 'Being',
    lensIdentity: 'UNITY, stage 9 · ULTRAVIOLET, Blissy Adept',
  },
  10: {
    persona: 'Whole Adept',
    descriptor: 'Pure Awareness',
    arrowLabel: '',
    watermark: 'EMPTINESS',
    category: 'Awareness',
    lensIdentity: 'EMPTINESS, stage 10 · CLEAR LIGHT, Whole Adept',
  },
};

/** The six right-column rows, top to bottom. */
export const GOLDEN_ROWS: readonly GoldenRow[] = [
  { category: 'Awareness', fallbackLines: ['Aware-', 'ness'], stageNumbers: [10] },
  { category: 'Being', fallbackLines: ['Being'], stageNumbers: [9] },
  { category: 'Wisdom', fallbackLines: ['Wisdom'], stageNumbers: [8, 7] },
  { category: 'Understanding', fallbackLines: ['Under-', 'standing'], stageNumbers: [6, 5] },
  { category: 'Love', fallbackLines: ['Love'], stageNumbers: [4, 3] },
  { category: 'Yes-And-Ness', fallbackLines: ['Yes-And-', 'Ness'], stageNumbers: [2, 1] },
];

/** The title watermarks, top line first. */
export const GOLDEN_WATERMARKS: readonly string[] = ['EMPTINESS', 'UNITY'];

/** The stage numbers the golden covers, ascending. */
export const GOLDEN_STAGE_NUMBERS: readonly number[] = Object.keys(GOLDEN_STAGES)
  .map(Number)
  .sort((a, b) => a - b);

/** A stage's golden vocabulary, failing loudly rather than as `undefined`. */
export const goldenStage = (stageNumber: number): GoldenStage => {
  const golden = GOLDEN_STAGES[stageNumber];
  if (golden === undefined) throw new Error(`no golden vocabulary for stage ${stageNumber}`);
  return golden;
};

/** The four `StageData` fields the vocabulary derives from. */
export type CanonOverrides = Pick<
  StageData,
  'title' | 'category' | 'aspect' | 'relationshipToFreeWill'
>;

/** What `GET /stages` serves for each stage of a freshly seeded database. */
export const CANON_STAGE_OVERRIDES: Readonly<Record<number, CanonOverrides>> = {
  1: {
    title: 'Survival',
    category: 'Yes-And-Ness',
    aspect: 'Agency',
    relationshipToFreeWill: 'Biological Machine',
  },
  2: {
    title: 'Magick',
    category: 'Yes-And-Ness',
    aspect: 'Receptivity',
    relationshipToFreeWill: 'Pleasure Seeker',
  },
  3: { title: 'Power', category: 'Love', aspect: 'Self-Love', relationshipToFreeWill: 'Dominator' },
  4: {
    title: 'Conformity',
    category: 'Love',
    aspect: 'Community Love',
    relationshipToFreeWill: 'Victim',
  },
  5: {
    title: 'Achievist',
    category: 'Understanding',
    aspect: 'Intellectual Understanding',
    relationshipToFreeWill: 'Status Seeker',
  },
  6: {
    title: 'Pluralist',
    category: 'Understanding',
    aspect: 'Embodied Understanding',
    relationshipToFreeWill: 'Shadow Glorifier',
  },
  7: {
    title: 'Integrative',
    category: 'Wisdom',
    aspect: 'Systems Wisdom',
    relationshipToFreeWill: 'Despairing Analyst',
  },
  8: {
    title: 'True Self Connection',
    category: 'Wisdom',
    aspect: 'True Self Connection',
    relationshipToFreeWill: 'True Self Embodier',
  },
  9: {
    title: 'Effortless Being',
    category: 'Being',
    aspect: 'Unity',
    relationshipToFreeWill: 'Blissy Adept',
  },
  10: {
    title: 'Pure Awareness',
    category: 'Awareness',
    aspect: 'Emptiness',
    relationshipToFreeWill: 'Whole Adept',
  },
};

/** One stage as `GET /stages` serves it seeded, with per-test `overrides` on top. */
export function mockMakeCanonicalStage(
  stageNumber: number,
  overrides: Partial<StageData> = {},
): StageData {
  return mockMakeStage(stageNumber, { ...CANON_STAGE_OVERRIDES[stageNumber], ...overrides });
}

/** All ten canonical stages, highest-numbered first (the store's render order). */
export function createCanonicalStages(): StageData[] {
  return [...GOLDEN_STAGE_NUMBERS].reverse().map((n) => mockMakeCanonicalStage(n));
}
