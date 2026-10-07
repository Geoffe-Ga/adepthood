/**
 * Presentation data for the Map screen's "spiral of becoming" layout.
 *
 * The Map is a three-column table:
 *   - left column   — the colored stage text (persona / descriptor / practice)
 *   - center column — the colored-arrow spiral artwork with tap targets
 *   - right column  — the aspect-of-wholeness label for each row
 *
 * Stage *content* -- title, subtitle, progress, lock state, and since #2666
 * every stage word the Map shows (persona, descriptor, arrow label, watermark,
 * category; see ``stageVocabulary.ts``) -- comes from the backend via
 * ``useStageStore``. This module only holds the grid's structure, the fitting
 * rules, each stage's practice line and the per-stage colors that mirror the
 * arrow artwork. Colors are intentionally kept here (not in ``design/tokens``)
 * because they are tuned to match the supplied spiral PNG rather than the
 * app-wide spiral-dynamics swatches.
 */

import { editorialType, uiType } from '../../design/tokens';

import { isLeftReturning, STAGE_COUNT } from './stageData';
import { isTitleStage } from './stageVocabulary';

/** Flex weights of each stage row's three cells (left / center / right). */
export const GRID_COLUMN_FLEX = { left: 2, center: 2, right: 1 } as const;

/**
 * The static, design-specific part of a stage's left column: its practice line
 * and its artwork colours. The stage's words come from the server.
 */
export interface StageDisplay {
  stageNumber: number;
  /** Third line — the practice cultivated at this stage. */
  practice: string;
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

/**
 * A horizontal band of the table: one or two stages beside one category label.
 * The label is the category of the row's stages, read from the server
 * (``rowCategory``), and its fallback lines come from ``design/hyphenation``.
 */
export interface MapRow {
  /** Stage numbers contained in this row, ordered top → bottom. */
  stageNumbers: readonly number[];
}

// --- Fitting grid copy to the type ramp (#2960) ------------------------------
// Every fitted size is a Candle & Ink step, never an integer in between: a line
// steps down its ladder until it fits, and copy that fits nowhere on the ramp
// wraps at the floor rather than shrinking off it.

/** Every size the ramp sets at any width: the editorial faces and the button face. */
const RAMP_STEPS: readonly number[] = [
  editorialType.display.fontSize,
  editorialType.title.fontSize,
  editorialType.heading.fontSize,
  editorialType.body.fontSize,
  editorialType.note.fontSize,
  editorialType.caption.fontSize,
  editorialType.action.fontSize,
  editorialType.marginNote.fontSize,
  uiType.button.fontSize,
];

/** The ramp's steps from ``max`` down to ``min``, largest first, each once. */
const rampBetween = (max: number, min: number): readonly number[] =>
  [...new Set(RAMP_STEPS)].filter((step) => step >= min && step <= max).sort((a, b) => b - a);

/** The floor of every fitted line: the caption, the smallest step on the ramp. */
const FIT_FLOOR = editorialType.caption.fontSize;

/** Ceiling for the title watermark: ``editorialType.title``. */
export const TITLE_MAX_FONT_SIZE = editorialType.title.fontSize;

/** Floor for the title watermark: the caption, below which it leaves the ramp. */
export const TITLE_MIN_FONT_SIZE = FIT_FLOOR;

/** The watermark's ladder: every ramp step from the title face down to the caption. */
export const TITLE_LADDER = rampBetween(TITLE_MAX_FONT_SIZE, TITLE_MIN_FONT_SIZE);

/** Letter spacing (px) the title style renders with; part of the fit budget. */
export const TITLE_LETTER_SPACING = 1;

/**
 * Conservative average advance width of an uppercase serif glyph, in ems.
 * Deliberately generous (Georgia caps average ≈0.63em) so the estimate only
 * ever errs toward a smaller, guaranteed-fitting size.
 */
const TITLE_GLYPH_EM_WIDTH = 0.72;

/**
 * Conservative average advance width of a mixed-case glyph, in ems.
 * Deliberately generous (err toward smaller) so a single-line fit only ever
 * settles on a guaranteed-fitting size. Shared by the right-column aspect
 * labels and the left-column stage copy, whose budgets are the same number.
 */
export const MIXED_CASE_GLYPH_EM_WIDTH = 0.62;

/** A line's glyph budget: how wide each glyph runs at a given size. */
interface GlyphBudget {
  /** Average glyph advance width in ems. */
  em: number;
  /** Per-glyph letter spacing the style renders with, in px. */
  letterSpacing: number;
}

/** The mixed-case budget the stage copy, arrow labels and aspect labels share. */
const MIXED_CASE_BUDGET: GlyphBudget = { em: MIXED_CASE_GLYPH_EM_WIDTH, letterSpacing: 0 };

/** A ladder step and whether the line fits the width on one line at it. */
interface LadderFit {
  fontSize: number;
  fits: boolean;
}

/**
 * The largest step of ``ladder`` (sizes, largest first) at which ``text`` fits
 * ``width`` on one line, or the ladder's floor with ``fits: false`` when no
 * step does.
 *
 * The one estimator behind every fitted line on the Map -- title watermark,
 * aspect label, stage copy -- which differ only in their budget and ladder.
 * The native ``adjustsFontSizeToFit`` is a no-op on react-native-web and
 * shrinks off the ramp on native, so this deterministic step is the fit
 * everywhere. An unmeasured width (<= 0) or empty text takes the top step
 * until layout reports.
 */
const fitToLadder = (
  text: string,
  width: number,
  budget: GlyphBudget,
  ladder: readonly number[],
): LadderFit => {
  const top = ladder[0] ?? FIT_FLOOR;
  if (width <= 0 || text.length === 0) return { fontSize: top, fits: true };
  const step = ladder.find(
    (size) => text.length * (size * budget.em + budget.letterSpacing) <= width,
  );
  return step === undefined
    ? { fontSize: ladder.at(-1) ?? FIT_FLOOR, fits: false }
    : { fontSize: step, fits: true };
};

/** The longest of ``lines``, which sets the one size every watermark shares. */
const longestLine = (lines: readonly string[]): string =>
  lines.reduce((longest, line) => (line.length > longest.length ? line : longest), '');

/**
 * The watermark's size for a center cell ``width`` wide: the largest step at
 * which the LONGEST of the title ``lines`` (the watermarks the server's title
 * stages carry, see ``mapWatermarkLines``) fits on one line, so EMPTINESS and
 * UNITY always read at one size -- one face per role -- and neither truncates
 * or hyphenates. No lines yet (nothing loaded) takes the ladder's ceiling.
 */
export const fittedTitleFontSize = (width: number, lines: readonly string[]): number =>
  fitToLadder(
    longestLine(lines),
    width,
    { em: TITLE_GLYPH_EM_WIDTH, letterSpacing: TITLE_LETTER_SPACING },
    TITLE_LADDER,
  ).fontSize;

/** Ceiling for a right-column aspect label: ``editorialType.marginNote``. */
export const RIGHT_LABEL_MAX_FONT_SIZE = editorialType.marginNote.fontSize;

/** Floor for an aspect label: the caption. */
export const RIGHT_LABEL_MIN_FONT_SIZE = FIT_FLOOR;

/** The aspect label's ladder, ceiling to floor. */
export const RIGHT_LABEL_LADDER = rampBetween(RIGHT_LABEL_MAX_FONT_SIZE, RIGHT_LABEL_MIN_FONT_SIZE);

/** Line-height multiple the aspect label renders at: its margin-note face's rhythm. */
export const RIGHT_LABEL_LINE_HEIGHT_RATIO =
  editorialType.marginNote.lineHeight / editorialType.marginNote.fontSize;

/**
 * Fits a right-column aspect label to its measured cell width. The whole label
 * is preferred on one un-hyphenated line at the largest step it fits; only when
 * it fits no step does it fall back to the row's pre-hyphenated
 * ``fallbackLines``, which share the largest step their longest line fits (the
 * floor when none does). The fit only sizes the label: the caller never caps a
 * line's count, so a line that runs wider than the glyph estimate on some
 * serif face wraps instead of being cut to an ellipsis, while a line that fits
 * stays on one line. An unmeasured width (<= 0) renders the whole label at the
 * ceiling until layout reports.
 */
export const fitRightLabel = (
  label: string,
  fallbackLines: readonly string[],
  width: number,
): { lines: string[]; fontSize: number } => {
  const whole = fitToLadder(label, width, MIXED_CASE_BUDGET, RIGHT_LABEL_LADDER);
  if (whole.fits) return { lines: [label], fontSize: whole.fontSize };
  const fallbackFontSize = Math.min(
    ...fallbackLines.map(
      (line) => fitToLadder(line, width, MIXED_CASE_BUDGET, RIGHT_LABEL_LADDER).fontSize,
    ),
  );
  return { lines: [...fallbackLines], fontSize: fallbackFontSize };
};

/** Ceiling for the bold persona line: ``editorialType.marginNote``. */
export const STAGE_PERSONA_MAX_FONT_SIZE = editorialType.marginNote.fontSize;

/** Ceiling for the descriptor / practice lines: the caption. */
export const STAGE_LINE_MAX_FONT_SIZE = editorialType.caption.fontSize;

/** Ceiling for the center arrow label: the caption. */
export const ARROW_LABEL_MAX_FONT_SIZE = editorialType.caption.fontSize;

/** Floor for all stage copy: the caption. */
export const STAGE_TEXT_MIN_FONT_SIZE = FIT_FLOOR;

/** The persona's ladder, ceiling to floor. */
export const STAGE_PERSONA_LADDER = rampBetween(
  STAGE_PERSONA_MAX_FONT_SIZE,
  STAGE_TEXT_MIN_FONT_SIZE,
);

/** The descriptor / practice lines' ladder: the caption alone. */
export const STAGE_LINE_LADDER = rampBetween(STAGE_LINE_MAX_FONT_SIZE, STAGE_TEXT_MIN_FONT_SIZE);

/** The arrow label's ladder: the caption alone. */
export const ARROW_LABEL_LADDER = rampBetween(ARROW_LABEL_MAX_FONT_SIZE, STAGE_TEXT_MIN_FONT_SIZE);

/**
 * A stage line's fitted size and line budget: one line when it fits a step of
 * its ladder, or no cap (``undefined``) when it fits none, so copy too long for
 * the floor wraps inside its cell instead of truncating or leaving the ramp.
 */
export const fitStageLine = (
  text: string,
  width: number,
  ladder: readonly number[],
): { fontSize: number; numberOfLines: 1 | undefined } => {
  const { fontSize, fits } = fitToLadder(text, width, MIXED_CASE_BUDGET, ladder);
  return { fontSize, numberOfLines: fits ? 1 : undefined };
};

/**
 * Per-stage practice line and colors, keyed by ``stage_number`` (1–10). Stage
 * 10 is the top of the spiral and stage 1 the bottom.
 */
export const STAGE_DISPLAY: Readonly<Record<number, StageDisplay>> = {
  10: {
    stageNumber: 10,
    practice: 'Insight practice',
    textColor: '#1a1a1a',
    leftTextColor: '#141414',
  },
  9: {
    stageNumber: 9,
    practice: 'Concentration practice',
    textColor: '#9a5a78',
    leftTextColor: '#7d4961',
  },
  8: {
    stageNumber: 8,
    practice: "Dog Walkin' Shamanism",
    textColor: '#6d92a6',
    leftTextColor: '#415b6a',
  },
  7: {
    stageNumber: 7,
    practice: 'Blissy meditation',
    textColor: '#c9a43c',
    leftTextColor: '#6b561e',
  },
  6: {
    stageNumber: 6,
    practice: 'Shadow work',
    textColor: '#7cb273',
    leftTextColor: '#3c6135',
  },
  5: {
    stageNumber: 5,
    practice: 'Wim Hof method',
    textColor: '#dc9a5b',
    leftTextColor: '#804d1b',
  },
  4: {
    stageNumber: 4,
    practice: 'Metta',
    textColor: '#6f9bd4',
    leftTextColor: '#2c5993',
  },
  3: {
    stageNumber: 3,
    practice: 'Belly breathing',
    textColor: '#b14a3a',
    leftTextColor: '#943e31',
  },
  2: {
    stageNumber: 2,
    practice: 'Tarot meditation',
    textColor: '#5d4e9e',
    leftTextColor: '#5c4d9c',
  },
  1: {
    stageNumber: 1,
    practice: '5-4-3-2-1 grounding',
    textColor: '#cdb079',
    leftTextColor: '#6b5428',
  },
};

/**
 * The six table rows, top → bottom. The top two rows hold a single stage each
 * (the two title stages); the lower four each pair a cool-color "feminine"
 * stage above a warm-color "masculine" stage.
 */
export const MAP_ROWS: readonly MapRow[] = [
  { stageNumbers: [10] },
  { stageNumbers: [9] },
  { stageNumbers: [8, 7] },
  { stageNumbers: [6, 5] },
  { stageNumbers: [4, 3] },
  { stageNumbers: [2, 1] },
];

/**
 * Which corner of the center panel a stage's annotations hug. The Aspect label,
 * the locked note (padlock + unlock estimate) and the check badge sit on the
 * corner opposite the wave's return pole, so none lands under the strand: even
 * (left-returning) stages hug the right corner, odd stages the left. Title
 * stages (9, 10) carry no arrow label, but their locked note and badge take
 * the same corner by the same parity for their check badge (#2657); their locked note has its
 * own rule (``noteCorner``).
 */
export const labelCorner = (stageNumber: number): 'left' | 'right' =>
  isLeftReturning(stageNumber) ? 'right' : 'left';

/**
 * Whether the current stage's cell is held to the lens's height (#2960). The
 * lens rests centred on the current stage, and the grid's edges push it off
 * centre -- the bottom edge up into stage 2's aspect label and unlock copy -- so
 * a current stage's cell is at least ``LENS_MIN_HEIGHT`` and the caption stays
 * in its own stage. The top stage is the exception: the top edge pushes the
 * lens down onto stage 9, whose center cell then carries only its UNITY
 * watermark, an intended cover (stage 9 is unlocked once stage 10 is current,
 * and a title stage wears no aspect label). Holding it anyway lengthened the
 * completed Map and pushed Begin again's button below a desktop window's fold.
 */
export const currentStageHoldsLensRoom = (stageNumber: number): boolean =>
  stageNumber !== STAGE_COUNT;

/**
 * Which corner of the center cell a locked stage's note (padlock + unlock
 * estimate) hugs. A labelled stage keeps its note under its word, in the label
 * corner. The title stages sit where the wave converges: through both title
 * bands it rises from stage 9's right-hand pole into the apex without crossing
 * left of the cell centre (map-legibility.browser.e2e.test.ts measures it at
 * both profiles), so both notes take the left -- stage 10 against its parity.
 */
export const noteCorner = (stageNumber: number): 'left' | 'right' =>
  isTitleStage(stageNumber) ? 'left' : labelCorner(stageNumber);
