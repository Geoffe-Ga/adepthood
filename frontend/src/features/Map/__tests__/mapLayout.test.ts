/* eslint-env jest */
/* global describe, it, expect */
import { ink, surface } from '../../../design/tokens';
import {
  fittedTitleFontSize,
  GRID_COLUMN_FLEX,
  labelCorner,
  MAP_ROWS,
  MAP_TITLE_LINES,
  STAGE_DISPLAY,
  TITLE_MAX_FONT_SIZE,
  TITLE_MIN_FONT_SIZE,
} from '../mapLayout';
import { isLeftReturning, STAGE_COUNT } from '../stageData';

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

  it('gives every right-label at most two hyphenated lines, each within the cell width', () => {
    MAP_ROWS.forEach((row) => {
      expect(row.rightLabelLines.length).toBeGreaterThanOrEqual(1);
      expect(row.rightLabelLines.length).toBeLessThanOrEqual(2);
      row.rightLabelLines.forEach((line) => {
        expect(line.length).toBeLessThanOrEqual(MAX_RIGHT_LABEL_LINE_LENGTH);
      });
    });
  });

  it('rejoins each rightLabelLines back to its rightLabel, ignoring hyphen placement', () => {
    MAP_ROWS.forEach((row) => {
      const rejoined = row.rightLabelLines.join('').replaceAll('-', '');
      expect(rejoined).toBe(row.rightLabel.replaceAll('-', ''));
    });
  });

  it('hyphenates Understanding as Under- / standing', () => {
    expect(findRowByLabel('Understanding').rightLabelLines).toEqual(['Under-', 'standing']);
  });

  it('hyphenates Yes-And-Ness as Yes-And- / Ness', () => {
    expect(findRowByLabel('Yes-And-Ness').rightLabelLines).toEqual(['Yes-And-', 'Ness']);
  });

  it('keeps the shared column-flex weights the wave geometry also depends on', () => {
    expect(GRID_COLUMN_FLEX).toEqual({ left: 2, center: 2, right: 1 });
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
