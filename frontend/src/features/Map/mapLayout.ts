// frontend/features/Map/mapLayout.ts

/**
 * Presentation data for the Map screen's "spiral of becoming" layout.
 *
 * The Map is a three-column table:
 *   - left column   — the colored stage text (persona / descriptor / practice)
 *   - center column — the colored-arrow spiral artwork with tap targets
 *   - right column  — the aspect-of-wholeness label for each row
 *
 * Stage *content* (title, subtitle, progress, lock state) still comes from the
 * backend via ``useStageStore``; this module only holds the static, design-
 * specific copy and per-stage colors that mirror the arrow artwork. Colors are
 * intentionally kept here (not in ``design/tokens``) because they are tuned to
 * match the supplied spiral PNG rather than the app-wide spiral-dynamics swatches.
 */

/** Flex weights of each stage row's three cells (left / center / right). */
export const GRID_COLUMN_FLEX = { left: 2, center: 2, right: 1 } as const;

/** Static, design-specific copy + color for a single stage's left-column text. */
export interface StageDisplay {
  stageNumber: number;
  /** Bold first line — the egoic/identity "character" of the stage. */
  persona: string;
  /** Second line — the stage's mode of knowing. */
  descriptor: string;
  /** Third line — the practice cultivated at this stage. */
  practice: string;
  /** Short label overlaid on the arrow loop ('' for the title rows 9–10). */
  arrowLabel: string;
  /** Text color matching this stage's arrow in the artwork. */
  textColor: string;
}

/** A horizontal band of the table: one aspect label over one or two stages. */
export interface MapRow {
  /** Aspect-of-wholeness label shown in the right column. */
  rightLabel: string;
  /** Stage numbers contained in this row, ordered top → bottom. */
  stageNumbers: readonly number[];
}

/** The serif title across the top of the spiral (top → bottom). */
export const MAP_TITLE_LINES = ['EMPTINESS', 'UNITY'] as const;

/**
 * The title line each top stage carries in its own grid row (no absolute
 * overlay): stage 10 reads EMPTINESS, stage 9 reads UNITY. Stages 1–8 have none.
 */
export const TITLE_BY_STAGE: Readonly<Record<number, string>> = {
  10: MAP_TITLE_LINES[0],
  9: MAP_TITLE_LINES[1],
};

/**
 * Per-stage left-column copy and color, keyed by ``stage_number`` (1–10).
 * Stage 10 is the top of the spiral (Whole Adept) and stage 1 the bottom
 * (Biological Machine).
 */
export const STAGE_DISPLAY: Readonly<Record<number, StageDisplay>> = {
  10: {
    stageNumber: 10,
    persona: 'Whole Adept',
    descriptor: 'Pure Awareness',
    practice: 'Cultivate Vipassana',
    arrowLabel: '',
    textColor: '#1a1a1a',
  },
  9: {
    stageNumber: 9,
    persona: 'Blissy Adept',
    descriptor: 'Effortless Being',
    practice: 'Cultivate Samatha Jhanas',
    arrowLabel: '',
    textColor: '#9a5a78',
  },
  8: {
    stageNumber: 8,
    persona: 'Adept',
    descriptor: 'Nonduality',
    practice: 'Deep Intuition',
    arrowLabel: 'Nondual',
    textColor: '#6d92a6',
  },
  7: {
    stageNumber: 7,
    persona: 'Despairing Analyst',
    descriptor: 'Integrative',
    practice: 'Blissy Meditation',
    arrowLabel: 'Systems',
    textColor: '#c9a43c',
  },
  6: {
    stageNumber: 6,
    persona: 'Shadow Glorifier',
    descriptor: 'Pluralistic',
    practice: 'Shadow Work',
    arrowLabel: 'Embodied',
    textColor: '#7cb273',
  },
  5: {
    stageNumber: 5,
    persona: 'Status Seeker',
    descriptor: 'Achievest',
    practice: 'Wim Hof Method',
    arrowLabel: 'Intellectual',
    textColor: '#dc9a5b',
  },
  4: {
    stageNumber: 4,
    persona: 'Victim',
    descriptor: 'Conformity',
    practice: 'Metta Meditation',
    arrowLabel: 'Community',
    textColor: '#6f9bd4',
  },
  3: {
    stageNumber: 3,
    persona: 'Dominator',
    descriptor: 'Power',
    practice: 'Confidence Meditation',
    arrowLabel: 'Self-Interest',
    textColor: '#b14a3a',
  },
  2: {
    stageNumber: 2,
    persona: 'Pleasure Seeker',
    descriptor: 'Magic',
    practice: 'Divination',
    arrowLabel: 'Receptivity',
    textColor: '#5d4e9e',
  },
  1: {
    stageNumber: 1,
    persona: 'Biological Machine',
    descriptor: 'Survival',
    practice: '5-4-3-2-1 Technique',
    arrowLabel: 'Agency',
    textColor: '#cdb079',
  },
};

/**
 * The six table rows, top → bottom. The top two rows hold a single stage each
 * (under the EMPTINESS / UNITY title); the lower four each pair a cool-color
 * "feminine" stage above a warm-color "masculine" stage.
 */
export const MAP_ROWS: readonly MapRow[] = [
  { rightLabel: 'Awareness', stageNumbers: [10] },
  { rightLabel: 'Being', stageNumbers: [9] },
  { rightLabel: 'Wisdom', stageNumbers: [8, 7] },
  { rightLabel: 'Understanding', stageNumbers: [6, 5] },
  { rightLabel: 'Love', stageNumbers: [4, 3] },
  { rightLabel: 'Yes-And-Ness', stageNumbers: [2, 1] },
];
