/* eslint-env jest */
/* global describe, it, expect */
import { ink, surface } from '../../../design/tokens';
import {
  fitRightLabel,
  fittedTitleFontSize,
  labelCorner,
  MAP_ROWS,
  MAP_TITLE_LINES,
  RIGHT_LABEL_GLYPH_EM_WIDTH,
  RIGHT_LABEL_MAX_FONT_SIZE,
  RIGHT_LABEL_MIN_FONT_SIZE,
  STAGE_DISPLAY,
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
    // word instead: fitRightLabel shrinks its font size to fit at render
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

  it('keeps Understanding as a single un-hyphenated fallback line (fitRightLabel shrinks it to fit)', () => {
    const lines = findRowByLabel('Understanding').rightLabelLines;
    expect(lines).toEqual(['Understanding']);
    lines.forEach((line) => expect(line).not.toContain('-'));
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

  it('renames stage 3 arrow label from Self-Interest to Self-Love', () => {
    expect(STAGE_DISPLAY[3]?.arrowLabel).toBe('Self-Love');
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

  it('always hugs the corner opposite the wave return pole', () => {
    for (let stageNumber = 1; stageNumber <= 8; stageNumber += 1) {
      const expected = isLeftReturning(stageNumber) ? 'right' : 'left';
      expect(labelCorner(stageNumber)).toBe(expected);
    }
  });
});

describe('fittedTitleFontSize', () => {
  // The conservative glyph-advance estimate the fit is computed against; a
  // fitted size is correct when estimated line width never exceeds the cell.
  const GLYPH_EM_WIDTH = 0.72;
  const LETTER_SPACING = 1;
  const estimatedWidth = (title: string, fontSize: number): number =>
    title.length * fontSize * GLYPH_EM_WIDTH + title.length * LETTER_SPACING;

  it('renders at the ceiling before layout reports a width', () => {
    expect(fittedTitleFontSize('EMPTINESS', 0)).toBe(TITLE_MAX_FONT_SIZE);
  });

  it('caps a short word in a wide cell at the type ramp ceiling', () => {
    expect(fittedTitleFontSize('UNITY', 400)).toBe(TITLE_MAX_FONT_SIZE);
  });

  it('shrinks EMPTINESS so its estimated width fits a phone-width center cell', () => {
    for (const width of [120, 140, 160, 200]) {
      const size = fittedTitleFontSize('EMPTINESS', width);
      expect(size).toBeLessThanOrEqual(TITLE_MAX_FONT_SIZE);
      expect(estimatedWidth('EMPTINESS', size)).toBeLessThanOrEqual(width);
    }
  });

  it('never shrinks below the legibility floor', () => {
    expect(fittedTitleFontSize('EMPTINESS', 10)).toBe(TITLE_MIN_FONT_SIZE);
  });

  it('fits every configured title line, not just the current copy', () => {
    const NARROW_CELL = 130;
    for (const title of MAP_TITLE_LINES) {
      const size = fittedTitleFontSize(title, NARROW_CELL);
      expect(size).toBeGreaterThanOrEqual(TITLE_MIN_FONT_SIZE);
      if (size > TITLE_MIN_FONT_SIZE) {
        expect(estimatedWidth(title, size)).toBeLessThanOrEqual(NARROW_CELL);
      }
    }
  });
});

describe('fitRightLabel', () => {
  const UNDERSTANDING_FALLBACK = ['Under-', 'standing'] as const;
  const YES_AND_NESS_FALLBACK = ['Yes-And-', 'Ness'] as const;
  const WIDE_CELL = 180;
  const NARROW_PHONE_CELL = 56;

  // Same conservative advance-width idiom fittedTitleFontSize's own tests use,
  // scoped to the right label's own glyph budget.
  const estimatedLineWidth = (line: string, fontSize: number): number =>
    line.length * fontSize * RIGHT_LABEL_GLYPH_EM_WIDTH;

  it('renders the full label on one un-hyphenated line at the ceiling before layout reports a width', () => {
    const result = fitRightLabel('Understanding', UNDERSTANDING_FALLBACK, 0);
    expect(result).toEqual({ lines: ['Understanding'], fontSize: RIGHT_LABEL_MAX_FONT_SIZE });
  });

  it('keeps Understanding on one line at the ceiling size in a wide cell', () => {
    const result = fitRightLabel('Understanding', UNDERSTANDING_FALLBACK, WIDE_CELL);
    expect(result).toEqual({ lines: ['Understanding'], fontSize: RIGHT_LABEL_MAX_FONT_SIZE });
  });

  it('keeps every returned line within the measured cell width whenever the size shrinks below the ceiling', () => {
    for (const width of [40, 56, 70, 90, 120, 150]) {
      const result = fitRightLabel('Understanding', UNDERSTANDING_FALLBACK, width);
      if (result.fontSize > RIGHT_LABEL_MIN_FONT_SIZE) {
        result.lines.forEach((line) => {
          expect(estimatedLineWidth(line, result.fontSize)).toBeLessThanOrEqual(width);
        });
      }
    }
  });

  it('clamps fontSize to the configured floor and ceiling for every width, including non-positive ones', () => {
    for (const width of [-10, 0, 20, 56, 90, 180, 500]) {
      const result = fitRightLabel('Understanding', UNDERSTANDING_FALLBACK, width);
      expect(result.fontSize).toBeGreaterThanOrEqual(RIGHT_LABEL_MIN_FONT_SIZE);
      expect(result.fontSize).toBeLessThanOrEqual(RIGHT_LABEL_MAX_FONT_SIZE);
    }
  });

  it('shrinks Awareness to fit a narrow phone cell on one line without splitting the word', () => {
    const result = fitRightLabel('Awareness', ['Awareness'], NARROW_PHONE_CELL);
    expect(result.lines).toEqual(['Awareness']);
    expect(result.fontSize).toBeGreaterThanOrEqual(RIGHT_LABEL_MIN_FONT_SIZE);
    expect(result.fontSize).toBeLessThan(RIGHT_LABEL_MAX_FONT_SIZE);
  });

  it('falls back to the pre-hyphenated Yes-And-Ness lines instead of inserting a new hyphen', () => {
    const NARROW_WIDTH = 40;
    const result = fitRightLabel('Yes-And-Ness', YES_AND_NESS_FALLBACK, NARROW_WIDTH);
    expect(result.lines).toEqual(['Yes-And-', 'Ness']);
    // Exactly the label's own two hyphens survive — none inserted elsewhere.
    const hyphenCount = (result.lines.join('').match(/-/g) ?? []).length;
    expect(hyphenCount).toBe(2);
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
