/* eslint-env jest */
/* global describe, it, expect */
import { editorialType, ink, surface, uiType } from '../../../design/tokens';
import {
  ARROW_LABEL_LADDER,
  ARROW_LABEL_MAX_FONT_SIZE,
  fitRightLabel,
  fitStageLine,
  fittedTitleFontSize,
  labelCorner,
  noteCorner,
  MAP_ROWS,
  MAP_TITLE_LINES,
  MIXED_CASE_GLYPH_EM_WIDTH,
  RIGHT_LABEL_MAX_FONT_SIZE,
  RIGHT_LABEL_LADDER,
  RIGHT_LABEL_MIN_FONT_SIZE,
  STAGE_DISPLAY,
  STAGE_LINE_LADDER,
  STAGE_LINE_MAX_FONT_SIZE,
  STAGE_PERSONA_LADDER,
  STAGE_PERSONA_MAX_FONT_SIZE,
  STAGE_TEXT_MIN_FONT_SIZE,
  TITLE_LADDER,
  TITLE_MAX_FONT_SIZE,
  TITLE_MIN_FONT_SIZE,
} from '../mapLayout';
import { isLeftReturning, STAGE_COUNT } from '../stageData';
import { centerColumnBounds } from '../waveGeometry';

const HEX_COLOR = /^#[\da-f]{6}$/i;
const ALL_STAGES = Array.from({ length: STAGE_COUNT }, (_, i) => STAGE_COUNT - i);
const MAX_RIGHT_LABEL_LINE_LENGTH = 9;

/** WCAG relative luminance of a #rrggbb color. */
const luminance = (hex: string): number => {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a 6-digit hex: ${hex}`);
  const channels = [match[1], match[2], match[3]].map((pair) => {
    const c = Number.parseInt(pair!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

const contrast = (a: string, b: string): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

const AA_NORMAL = 4.5;

// Locate a stage's display copy, failing loudly (not with a false-positive
// undefined) if a stage number is ever missing from STAGE_DISPLAY.
const requireDisplay = (stageNumber: number) => {
  const display = STAGE_DISPLAY[stageNumber];
  if (!display) {
    throw new Error(`no STAGE_DISPLAY entry for stage ${stageNumber}`);
  }
  return display;
};

// Locate a row by its rightLabel, failing loudly (not with a false-positive
// undefined) if the expected copy ever moves or is renamed.
const findRowByLabel = (label: string) => {
  const row = MAP_ROWS.find((r) => r.rightLabel === label);
  if (!row) {
    throw new Error(`no MAP_ROWS entry with rightLabel ${label}`);
  }
  return row;
};

describe('mapLayout', () => {
  it('defines display copy for every stage', () => {
    ALL_STAGES.forEach((stageNumber) => {
      const display = STAGE_DISPLAY[stageNumber];
      expect(display).toBeDefined();
      expect(display?.stageNumber).toBe(stageNumber);
      expect(display?.persona).toBeTruthy();
      expect(display?.descriptor).toBeTruthy();
      expect(display?.practice).toBeTruthy();
      expect(display?.textColor).toMatch(HEX_COLOR);
    });
  });

  it('omits the arrow label only on the two title stages (9 and 10)', () => {
    const labelled = ALL_STAGES.filter((n) => STAGE_DISPLAY[n]?.arrowLabel !== '');
    const titleStages = ALL_STAGES.filter((n) => STAGE_DISPLAY[n]?.arrowLabel === '');
    expect(titleStages.sort((a, b) => a - b)).toEqual([9, 10]);
    expect(labelled).toHaveLength(STAGE_COUNT - 2);
  });

  it('covers all ten stages across six rows, top → bottom', () => {
    expect(MAP_ROWS).toHaveLength(6);
    const ordered = MAP_ROWS.flatMap((row) => row.stageNumbers);
    expect(ordered).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    MAP_ROWS.forEach((row) => expect(row.rightLabel).toBeTruthy());
  });

  it('exposes the EMPTINESS / UNITY title', () => {
    expect(MAP_TITLE_LINES).toEqual(['EMPTINESS', 'UNITY']);
  });

  it('gives every two-line right-label fallback two hyphenated lines, each within the cell width', () => {
    // Single-line fallbacks (the common case) carry the full, un-truncated
    // word instead: fitRightLabel steps it down the ramp to fit at render
    // time, so they are not bound by the old fixed-width hyphenation budget.
    MAP_ROWS.forEach((row) => {
      expect(row.rightLabelLines.length).toBeGreaterThanOrEqual(1);
      expect(row.rightLabelLines.length).toBeLessThanOrEqual(2);
      if (row.rightLabelLines.length === 2) {
        row.rightLabelLines.forEach((line) => {
          expect(line.length).toBeLessThanOrEqual(MAX_RIGHT_LABEL_LINE_LENGTH);
        });
      }
    });
  });

  it('rejoins each rightLabelLines back to its rightLabel, ignoring hyphen placement', () => {
    MAP_ROWS.forEach((row) => {
      const rejoined = row.rightLabelLines.join('').replaceAll('-', '');
      expect(rejoined).toBe(row.rightLabel.replaceAll('-', ''));
    });
  });

  it('hyphenates Understanding as Under- / standing, for a cell too narrow for the word on the ramp', () => {
    // fitRightLabel still prefers the whole word wherever it fits at 13px or more.
    expect(findRowByLabel('Understanding').rightLabelLines).toEqual(['Under-', 'standing']);
  });

  it('hyphenates Awareness as Aware- / ness, for a 320 phone whose cell the word overruns at the floor', () => {
    expect(findRowByLabel('Awareness').rightLabelLines).toEqual(['Aware-', 'ness']);
  });

  it('hyphenates Yes-And-Ness as Yes-And- / Ness', () => {
    expect(findRowByLabel('Yes-And-Ness').rightLabelLines).toEqual(['Yes-And-', 'Ness']);
  });

  it('keeps the shared column-flex weights the wave geometry also depends on', () => {
    // 2:2:1 ratio: center column matches the left gutter; right gutter is half that.
    const width = 500;
    const bounds = centerColumnBounds(width);
    const centerWidth = bounds.right - bounds.left;
    const rightGutter = width - bounds.right;

    expect(bounds.left).toBeCloseTo(200);
    expect(bounds.right).toBeCloseTo(400);
    expect(bounds.left).toBeCloseTo(centerWidth);
    expect(rightGutter).toBeCloseTo(centerWidth / 2);
  });

  it('hugs odd stages left and even stages right', () => {
    expect(labelCorner(1)).toBe('left');
    expect(labelCorner(2)).toBe('right');
    expect(labelCorner(3)).toBe('left');
    expect(labelCorner(4)).toBe('right');
    expect(labelCorner(5)).toBe('left');
    expect(labelCorner(6)).toBe('right');
    expect(labelCorner(7)).toBe('left');
    expect(labelCorner(8)).toBe('right');
  });

  // #2657: the title stages' check badges take a corner by the same parity.
  it('gives the title stages a corner by the same parity: 9 left, 10 right', () => {
    expect(labelCorner(9)).toBe('left');
    expect(labelCorner(10)).toBe('right');
  });
});

describe('noteCorner', () => {
  it("puts a labelled stage's locked note in its label corner", () => {
    for (let stageNumber = 1; stageNumber <= 8; stageNumber += 1) {
      expect(noteCorner(stageNumber)).toBe(labelCorner(stageNumber));
    }
  });

  // Through both title bands the converging wave runs right of the cell centre
  // (measured by map-legibility.browser.e2e.test.ts), so both notes go left --
  // stage 10 against its own parity.
  it("puts both title stages' locked notes on the left, where the converging wave is not", () => {
    expect(noteCorner(9)).toBe('left');
    expect(noteCorner(10)).toBe('left');
  });

  it('always hugs the corner opposite the wave return pole', () => {
    for (let stageNumber = 1; stageNumber <= 10; stageNumber += 1) {
      const expected = isLeftReturning(stageNumber) ? 'right' : 'left';
      expect(labelCorner(stageNumber)).toBe(expected);
    }
  });
});

/** Every size the Candle & Ink ramp sets whatever the width: ``editorialType`` and the button face. */
const RAMP_STEPS = new Set([
  editorialType.display.fontSize,
  editorialType.title.fontSize,
  editorialType.heading.fontSize,
  editorialType.body.fontSize,
  editorialType.note.fontSize,
  editorialType.caption.fontSize,
  editorialType.action.fontSize,
  editorialType.marginNote.fontSize,
  uiType.button.fontSize,
]);
const RAMP_FLOOR = editorialType.caption.fontSize;
/** A hair under a fit's exact edge, to prove the step changes there and not before. */
const JUST_UNDER = 0.01;

describe('the fitted grid sizes are ramp steps (#2960)', () => {
  const BOUNDS = {
    TITLE_MAX_FONT_SIZE,
    TITLE_MIN_FONT_SIZE,
    RIGHT_LABEL_MAX_FONT_SIZE,
    RIGHT_LABEL_MIN_FONT_SIZE,
    STAGE_PERSONA_MAX_FONT_SIZE,
    STAGE_LINE_MAX_FONT_SIZE,
    ARROW_LABEL_MAX_FONT_SIZE,
    STAGE_TEXT_MIN_FONT_SIZE,
  };

  it.each(Object.entries(BOUNDS))(
    '%s (%i) is a ramp step no smaller than the caption',
    (_, size) => {
      expect(RAMP_STEPS.has(size)).toBe(true);
      expect(size).toBeGreaterThanOrEqual(RAMP_FLOOR);
    },
  );

  it('reads each bound off the face it names', () => {
    expect(TITLE_MAX_FONT_SIZE).toBe(editorialType.title.fontSize);
    expect(RIGHT_LABEL_MAX_FONT_SIZE).toBe(editorialType.marginNote.fontSize);
    expect(STAGE_PERSONA_MAX_FONT_SIZE).toBe(editorialType.marginNote.fontSize);
    expect(STAGE_LINE_MAX_FONT_SIZE).toBe(editorialType.caption.fontSize);
    expect(ARROW_LABEL_MAX_FONT_SIZE).toBe(editorialType.caption.fontSize);
    for (const floor of [
      TITLE_MIN_FONT_SIZE,
      RIGHT_LABEL_MIN_FONT_SIZE,
      STAGE_TEXT_MIN_FONT_SIZE,
    ]) {
      expect(floor).toBe(editorialType.caption.fontSize);
    }
  });

  it('walks each ladder down every ramp step between its bounds, and no other size', () => {
    expect(TITLE_LADDER).toEqual([26, 20, 18, 16, 15, 14, 13]);
    expect(STAGE_PERSONA_LADDER).toEqual([14, 13]);
    expect(RIGHT_LABEL_LADDER).toEqual([14, 13]);
    expect(STAGE_LINE_LADDER).toEqual([13]);
    expect(ARROW_LABEL_LADDER).toEqual([13]);
    expect(TITLE_LADDER[0]).toBe(TITLE_MAX_FONT_SIZE);
    expect(TITLE_LADDER.at(-1)).toBe(TITLE_MIN_FONT_SIZE);
  });
});

describe('fittedTitleFontSize', () => {
  // The conservative glyph-advance estimate the fit is computed against; a
  // fitted size is correct when estimated line width never exceeds the cell.
  const GLYPH_EM_WIDTH = 0.72;
  const LETTER_SPACING = 1;
  /** A title line's estimated width at ``fontSize``: its glyph advances plus its letter spacing. */
  const estimatedWidth = (title: string, fontSize: number): number =>
    title.length * (fontSize * GLYPH_EM_WIDTH + LETTER_SPACING);
  const LONGEST_TITLE = 'EMPTINESS';

  it('renders at the ceiling before layout reports a width', () => {
    expect(fittedTitleFontSize(0)).toBe(TITLE_MAX_FONT_SIZE);
  });

  it('holds the ceiling wherever the longest title line fits it', () => {
    expect(fittedTitleFontSize(1000)).toBe(TITLE_MAX_FONT_SIZE);
  });

  it('steps down the ramp at the exact width the longer line stops fitting', () => {
    // EMPTINESS at 20px: 9 * (20 * 0.72 + 1) = 138.6.
    const edge = estimatedWidth(LONGEST_TITLE, editorialType.heading.fontSize);
    expect(fittedTitleFontSize(edge)).toBe(editorialType.heading.fontSize);
    expect(fittedTitleFontSize(edge - JUST_UNDER)).toBe(editorialType.body.fontSize);
  });

  it('sizes EMPTINESS and UNITY together, off the longer line, so the watermark shows one size', () => {
    // A phone's center cell: UNITY alone would fit 26, EMPTINESS only 20.
    const PHONE_CELL = 142;
    expect(fittedTitleFontSize(PHONE_CELL)).toBe(editorialType.heading.fontSize);
    expect(MAP_TITLE_LINES.map((line) => line.length).sort((a, b) => b - a)[0]).toBe(
      LONGEST_TITLE.length,
    );
  });

  it('keeps every title line inside the cell whenever a step fits', () => {
    for (const width of [100, 120, 140, 160, 200, 400]) {
      const size = fittedTitleFontSize(width);
      for (const title of MAP_TITLE_LINES) {
        expect(estimatedWidth(title, size)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('stops at the caption floor rather than leaving the ramp', () => {
    expect(fittedTitleFontSize(10)).toBe(TITLE_MIN_FONT_SIZE);
  });
});

describe('fitRightLabel', () => {
  const understanding = findRowByLabel('Understanding');
  const yesAndNess = findRowByLabel('Yes-And-Ness');
  const awareness = findRowByLabel('Awareness');
  const WIDE_CELL = 400;
  /** The right cell's content box on a 390 phone. */
  const PHONE_CELL = 59;
  /** The right cell's content box on a 320 phone, the narrowest the app supports. */
  const NARROWEST_PHONE_CELL = 48;
  /** Every measured cell width the sweep checks: one past unmeasured, up to a wide desktop. */
  const MAX_SWEPT_CELL = 1600;

  const estimatedLineWidth = (line: string, fontSize: number): number =>
    line.length * fontSize * MIXED_CASE_GLYPH_EM_WIDTH;

  it('renders the full label on one line at the ceiling before layout reports a width', () => {
    const result = fitRightLabel(understanding.rightLabel, understanding.rightLabelLines, 0);
    expect(result).toEqual({
      lines: ['Understanding'],
      fontSize: RIGHT_LABEL_MAX_FONT_SIZE,
      numberOfLines: 1,
    });
  });

  it('keeps Understanding whole at the ceiling wherever it fits', () => {
    const result = fitRightLabel('Understanding', understanding.rightLabelLines, WIDE_CELL);
    expect(result).toEqual({
      lines: ['Understanding'],
      fontSize: RIGHT_LABEL_MAX_FONT_SIZE,
      numberOfLines: 1,
    });
  });

  it('prefers the whole word one step down before it hyphenates', () => {
    // Understanding at 13px: 13 * 13 * 0.62 = 104.78; at 14px: 112.84.
    expect(fitRightLabel('Understanding', understanding.rightLabelLines, 105)).toEqual({
      lines: ['Understanding'],
      fontSize: RIGHT_LABEL_MIN_FONT_SIZE,
      numberOfLines: 1,
    });
    expect(fitRightLabel('Understanding', understanding.rightLabelLines, 104)).toEqual({
      lines: ['Under-', 'standing'],
      fontSize: RIGHT_LABEL_MAX_FONT_SIZE,
      numberOfLines: 1,
    });
  });

  it('hyphenates Understanding at a phone right cell rather than shrinking below the ramp', () => {
    // standing at 13px: 8 * 13 * 0.62 = 64.48, over the cell by the estimate,
    // so the lines stay free to wrap rather than being cut.
    const result = fitRightLabel('Understanding', understanding.rightLabelLines, PHONE_CELL);
    expect(result).toEqual({
      lines: ['Under-', 'standing'],
      fontSize: RIGHT_LABEL_MIN_FONT_SIZE,
      numberOfLines: undefined,
    });
  });

  it('sizes the fallback lines together off the longest of them', () => {
    // standing at 14px: 8 * 14 * 0.62 = 69.44; at 13px: 64.48.
    expect(fitRightLabel('Understanding', understanding.rightLabelLines, 70).fontSize).toBe(
      RIGHT_LABEL_MAX_FONT_SIZE,
    );
    expect(fitRightLabel('Understanding', understanding.rightLabelLines, 69).fontSize).toBe(
      RIGHT_LABEL_MIN_FONT_SIZE,
    );
  });

  it('keeps every line inside the cell whenever it lands above the floor', () => {
    for (const width of [40, 56, 70, 90, 120, 150]) {
      const result = fitRightLabel('Understanding', understanding.rightLabelLines, width);
      if (result.fontSize > RIGHT_LABEL_MIN_FONT_SIZE) {
        result.lines.forEach((line) => {
          expect(estimatedLineWidth(line, result.fontSize)).toBeLessThanOrEqual(width);
        });
      }
    }
  });

  it('lets a label that fits no step, even hyphenated, wrap at the floor instead of cutting it to an ellipsis', () => {
    const result = fitRightLabel('Awareness', ['Awareness'], 40);
    expect(result).toEqual({
      lines: ['Awareness'],
      fontSize: RIGHT_LABEL_MIN_FONT_SIZE,
      numberOfLines: undefined,
    });
  });

  it('hyphenates Awareness in a 320 phone cell and lets Yes-And- wrap at its hyphen there', () => {
    // Aware- at 13px: 6 * 13 * 0.62 = 48.36, a hair over the cell by the
    // estimate, so the line may wrap; the real serif glyphs run far narrower.
    expect(
      fitRightLabel(awareness.rightLabel, awareness.rightLabelLines, NARROWEST_PHONE_CELL),
    ).toEqual({
      lines: ['Aware-', 'ness'],
      fontSize: RIGHT_LABEL_MIN_FONT_SIZE,
      numberOfLines: undefined,
    });
    // Yes-And- at 13px: 8 * 13 * 0.62 = 64.48, and 50px of real glyphs: too
    // wide for the 48px line either way, so it must be free to wrap.
    expect(
      fitRightLabel(yesAndNess.rightLabel, yesAndNess.rightLabelLines, NARROWEST_PHONE_CELL),
    ).toEqual({
      lines: ['Yes-And-', 'Ness'],
      fontSize: RIGHT_LABEL_MIN_FONT_SIZE,
      numberOfLines: undefined,
    });
  });

  it('caps a label to one line per line only where every line fits by the estimate, at every cell width', () => {
    /** Whether the fit's line cap disagrees with the estimate at this width. */
    const miscapped = (label: string, lines: readonly string[], width: number): boolean => {
      const result = fitRightLabel(label, lines, width);
      const fits = result.lines.every((line) => estimatedLineWidth(line, result.fontSize) <= width);
      return (result.numberOfLines === 1) !== fits;
    };
    const wrong: string[] = [];
    for (let width = 1; width <= MAX_SWEPT_CELL; width += 1) {
      for (const row of MAP_ROWS) {
        if (miscapped(row.rightLabel, row.rightLabelLines, width)) {
          wrong.push(`${row.rightLabel}@${String(width)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('falls back to the pre-hyphenated Yes-And-Ness lines instead of inserting a new hyphen', () => {
    const result = fitRightLabel(yesAndNess.rightLabel, yesAndNess.rightLabelLines, 40);
    expect(result.lines).toEqual(['Yes-And-', 'Ness']);
    const hyphenCount = (result.lines.join('').match(/-/g) ?? []).length;
    expect(hyphenCount).toBe(2);
  });
});

describe('fitStageLine', () => {
  const stage8 = requireDisplay(8);
  const WIDE_CELL = 400;

  it('renders at the top of its ladder on one line before layout reports a width', () => {
    expect(fitStageLine(stage8.persona, 0, STAGE_PERSONA_LADDER)).toEqual({
      fontSize: STAGE_PERSONA_MAX_FONT_SIZE,
      numberOfLines: 1,
    });
  });

  it('renders empty text at the top of its ladder', () => {
    expect(fitStageLine('', WIDE_CELL, STAGE_LINE_LADDER)).toEqual({
      fontSize: STAGE_LINE_MAX_FONT_SIZE,
      numberOfLines: 1,
    });
  });

  it('holds a line that fits at the top of its ladder, on one line', () => {
    expect(fitStageLine(stage8.persona, WIDE_CELL, STAGE_PERSONA_LADDER)).toEqual({
      fontSize: STAGE_PERSONA_MAX_FONT_SIZE,
      numberOfLines: 1,
    });
    expect(fitStageLine('Metta', 120, STAGE_LINE_LADDER)).toEqual({
      fontSize: STAGE_LINE_MAX_FONT_SIZE,
      numberOfLines: 1,
    });
  });

  it('steps the persona down one ramp step at the exact width it stops fitting', () => {
    // True Self Embodier: 18 glyphs, so 18 * 14 * 0.62 = 156.24 at the top step.
    const edge = stage8.persona.length * (STAGE_PERSONA_MAX_FONT_SIZE * MIXED_CASE_GLYPH_EM_WIDTH);
    expect(fitStageLine(stage8.persona, edge, STAGE_PERSONA_LADDER)).toEqual({
      fontSize: STAGE_PERSONA_MAX_FONT_SIZE,
      numberOfLines: 1,
    });
    expect(fitStageLine(stage8.persona, edge - JUST_UNDER, STAGE_PERSONA_LADDER)).toEqual({
      fontSize: STAGE_TEXT_MIN_FONT_SIZE,
      numberOfLines: 1,
    });
  });

  it('wraps copy that cannot fit at the floor instead of leaving the ramp', () => {
    // Concentration practice at 13px: 22 * 13 * 0.62 = 177.32 > 120.
    expect(fitStageLine('Concentration practice', 120, STAGE_LINE_LADDER)).toEqual({
      fontSize: STAGE_TEXT_MIN_FONT_SIZE,
      numberOfLines: undefined,
    });
    expect(fitStageLine(stage8.persona, 10, STAGE_PERSONA_LADDER)).toEqual({
      fontSize: STAGE_TEXT_MIN_FONT_SIZE,
      numberOfLines: undefined,
    });
  });
});

describe('left-column stage text color', () => {
  it('gives every stage a valid left-column text hex color', () => {
    ALL_STAGES.forEach((stageNumber) => {
      expect(requireDisplay(stageNumber).leftTextColor).toMatch(HEX_COLOR);
    });
  });

  it('meets WCAG AA for the left-column text on the canvas ground', () => {
    ALL_STAGES.forEach((stageNumber) => {
      const display = requireDisplay(stageNumber);
      expect(contrast(display.leftTextColor, surface.canvas)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });

  it('is strictly darker than the matching wave color', () => {
    ALL_STAGES.forEach((stageNumber) => {
      const display = requireDisplay(stageNumber);
      expect(luminance(display.leftTextColor)).toBeLessThan(luminance(display.textColor));
    });
  });

  it('is darker than the EMPTINESS / UNITY title watermark ink', () => {
    ALL_STAGES.forEach((stageNumber) => {
      const display = requireDisplay(stageNumber);
      expect(luminance(display.leftTextColor)).toBeLessThan(luminance(ink.muted));
    });
  });
});
