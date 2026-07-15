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

import { isLeftReturning } from './stageData';

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
  /**
   * Darker variant of ``textColor`` for the left-column stage text. Same hue as
   * ``textColor`` with HSL lightness reduced until it clears WCAG AA 4.5:1
   * (~6.5:1 with margin) on the Map's parchment ground (``surface.canvas``
   * #faf6ef), landing strictly darker (lower relative luminance) than both its
   * own ``textColor`` and the UNITY/EMPTINESS watermark ink. Precomputed — no
   * runtime color math.
   */
  leftTextColor: string;
}

/** A horizontal band of the table: one aspect label over one or two stages. */
export interface MapRow {
  /** Aspect-of-wholeness label shown in the right column. */
  rightLabel: string;
  /** Pre-hyphenated right-column label lines (<= 2), avoiding shrink-to-fit. */
  rightLabelLines: readonly string[];
  /** Stage numbers contained in this row, ordered top → bottom. */
  stageNumbers: readonly number[];
}

/** The serif title across the top of the spiral (top → bottom). */
export const MAP_TITLE_LINES = ['EMPTINESS', 'UNITY'] as const;

/** Ceiling for the title watermark — ``editorialType.title``'s 26px. */
export const TITLE_MAX_FONT_SIZE = 26;

/** Floor below which the watermark would stop reading as a title. */
export const TITLE_MIN_FONT_SIZE = 12;

/** Letter spacing (px) the title style renders with; part of the fit budget. */
export const TITLE_LETTER_SPACING = 1;

/**
 * Conservative average advance width of an uppercase serif glyph, in ems.
 * Deliberately generous (Georgia caps average ≈0.63em) so the estimate only
 * ever errs toward a smaller, guaranteed-fitting size.
 */
const TITLE_GLYPH_EM_WIDTH = 0.72;

/**
 * Largest font size (capped at ``TITLE_MAX_FONT_SIZE``) at which ``title``
 * fits ``width`` on a single line. The native ``adjustsFontSizeToFit`` is not
 * implemented by react-native-web, so the watermark sizes itself from the
 * measured cell width instead — EMPTINESS / UNITY must never truncate or
 * hyphenate on any target. An unmeasured width (0) renders at the ceiling
 * until layout reports.
 */
export const fittedTitleFontSize = (title: string, width: number): number => {
  if (width <= 0 || title.length === 0) return TITLE_MAX_FONT_SIZE;
  const glyphBudget = width - TITLE_LETTER_SPACING * title.length;
  const fitted = Math.floor(glyphBudget / (title.length * TITLE_GLYPH_EM_WIDTH));
  return Math.max(TITLE_MIN_FONT_SIZE, Math.min(TITLE_MAX_FONT_SIZE, fitted));
};

/** Ceiling for a right-column aspect label — the legacy fixed size (15px). */
export const RIGHT_LABEL_MAX_FONT_SIZE = 15;

/** Floor below which an aspect label would stop reading as a label. */
export const RIGHT_LABEL_MIN_FONT_SIZE = 9;

/**
 * Conservative average advance width of a mixed-case serif glyph, in ems.
 * Deliberately generous (err toward smaller) so the single-line fit only ever
 * settles on a guaranteed-fitting size for the lowercase-heavy aspect words.
 */
export const RIGHT_LABEL_GLYPH_EM_WIDTH = 0.62;

/** Line-height multiple the aspect label renders at — the legacy 19/15 rhythm. */
export const RIGHT_LABEL_LINE_HEIGHT_RATIO = 19 / RIGHT_LABEL_MAX_FONT_SIZE;

/** Largest size (<= ceiling) at which ``line`` fits ``width`` on one line. */
const fittedLabelLineFontSize = (line: string, width: number): number => {
  if (width <= 0 || line.length === 0) return RIGHT_LABEL_MAX_FONT_SIZE;
  const fitted = Math.floor(width / (line.length * RIGHT_LABEL_GLYPH_EM_WIDTH));
  return Math.max(RIGHT_LABEL_MIN_FONT_SIZE, Math.min(RIGHT_LABEL_MAX_FONT_SIZE, fitted));
};

/** Whether ``line`` at ``fontSize`` fits within ``width`` by the em estimate. */
const labelLineFits = (line: string, fontSize: number, width: number): boolean =>
  line.length * fontSize * RIGHT_LABEL_GLYPH_EM_WIDTH <= width;

/**
 * Fits a right-column aspect label to its measured cell width, mirroring the
 * ``fittedTitleFontSize`` idiom. The label is preferred on a single
 * un-hyphenated line, shrinking from the ceiling toward the floor until it fits;
 * only when even the floor size overflows does it fall back to the row's
 * pre-hyphenated ``fallbackLines`` (each fitted to the same cell). An unmeasured
 * width (<= 0) renders the full label at the ceiling until layout reports.
 */
export const fitRightLabel = (
  label: string,
  fallbackLines: readonly string[],
  width: number,
): { lines: string[]; fontSize: number } => {
  if (width <= 0) return { lines: [label], fontSize: RIGHT_LABEL_MAX_FONT_SIZE };

  const singleFontSize = fittedLabelLineFontSize(label, width);
  if (labelLineFits(label, singleFontSize, width)) {
    return { lines: [label], fontSize: singleFontSize };
  }

  // Even at the floor the single word overflows — use the pre-hyphenated lines,
  // sized to the largest font at which the longest of them still fits.
  const fallbackFontSize = Math.min(
    ...fallbackLines.map((line) => fittedLabelLineFontSize(line, width)),
  );
  return { lines: [...fallbackLines], fontSize: fallbackFontSize };
};

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
    leftTextColor: '#141414',
  },
  9: {
    stageNumber: 9,
    persona: 'Blissy Adept',
    descriptor: 'Effortless Being',
    practice: 'Cultivate Samatha Jhanas',
    arrowLabel: '',
    textColor: '#9a5a78',
    leftTextColor: '#7d4961',
  },
  8: {
    stageNumber: 8,
    persona: 'Adept',
    descriptor: 'Nondual',
    practice: 'Deep Intuition',
    arrowLabel: 'Nondual',
    textColor: '#6d92a6',
    leftTextColor: '#415b6a',
  },
  7: {
    stageNumber: 7,
    persona: 'Despairing Analyst',
    descriptor: 'Integrative',
    practice: 'Blissy Meditation',
    arrowLabel: 'Systems',
    textColor: '#c9a43c',
    leftTextColor: '#6b561e',
  },
  6: {
    stageNumber: 6,
    persona: 'Shadow Glorifier',
    descriptor: 'Pluralist',
    practice: 'Shadow Work',
    arrowLabel: 'Embodied',
    textColor: '#7cb273',
    leftTextColor: '#3c6135',
  },
  5: {
    stageNumber: 5,
    persona: 'Status Seeker',
    descriptor: 'Achievist',
    practice: 'Wim Hof Method',
    arrowLabel: 'Intellectual',
    textColor: '#dc9a5b',
    leftTextColor: '#804d1b',
  },
  4: {
    stageNumber: 4,
    persona: 'Victim',
    descriptor: 'Conformity',
    practice: 'Metta Meditation',
    arrowLabel: 'Community',
    textColor: '#6f9bd4',
    leftTextColor: '#2c5993',
  },
  3: {
    stageNumber: 3,
    persona: 'Dominator',
    descriptor: 'Power',
    practice: 'Confidence Meditation',
    arrowLabel: 'Self-Love',
    textColor: '#b14a3a',
    leftTextColor: '#943e31',
  },
  2: {
    stageNumber: 2,
    persona: 'Pleasure Seeker',
    descriptor: 'Magick',
    practice: 'Divination',
    arrowLabel: 'Receptivity',
    textColor: '#5d4e9e',
    leftTextColor: '#5c4d9c',
  },
  1: {
    stageNumber: 1,
    persona: 'Biological Machine',
    descriptor: 'Survival',
    practice: '5-4-3-2-1 Technique',
    arrowLabel: 'Agency',
    textColor: '#cdb079',
    leftTextColor: '#6b5428',
  },
};

/**
 * The six table rows, top → bottom. The top two rows hold a single stage each
 * (under the EMPTINESS / UNITY title); the lower four each pair a cool-color
 * "feminine" stage above a warm-color "masculine" stage.
 */
export const MAP_ROWS: readonly MapRow[] = [
  { rightLabel: 'Awareness', rightLabelLines: ['Awareness'], stageNumbers: [10] },
  { rightLabel: 'Being', rightLabelLines: ['Being'], stageNumbers: [9] },
  { rightLabel: 'Wisdom', rightLabelLines: ['Wisdom'], stageNumbers: [8, 7] },
  { rightLabel: 'Understanding', rightLabelLines: ['Understanding'], stageNumbers: [6, 5] },
  { rightLabel: 'Love', rightLabelLines: ['Love'], stageNumbers: [4, 3] },
  { rightLabel: 'Yes-And-Ness', rightLabelLines: ['Yes-And-', 'Ness'], stageNumbers: [2, 1] },
];

/**
 * Which corner of the center panel a stage's Aspect label hugs. The label sits
 * on the corner opposite the wave's return pole, so the word never lands under
 * the strand: even (left-returning) stages hug the right corner, odd stages the
 * left. Title stages (9, 10) carry no arrow label and never call this.
 */
export const labelCorner = (stageNumber: number): 'left' | 'right' =>
  isLeftReturning(stageNumber) ? 'right' : 'left';
