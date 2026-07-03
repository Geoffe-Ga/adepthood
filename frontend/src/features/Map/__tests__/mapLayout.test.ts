/* eslint-env jest */
/* global describe, it, expect */
import {
  GRID_COLUMN_FLEX,
  labelCorner,
  MAP_ROWS,
  MAP_TITLE_LINES,
  STAGE_DISPLAY,
} from '../mapLayout';
import { isLeftReturning, STAGE_COUNT } from '../stageData';

const HEX_COLOR = /^#[\da-f]{6}$/i;
const ALL_STAGES = Array.from({ length: STAGE_COUNT }, (_, i) => STAGE_COUNT - i);
const MAX_RIGHT_LABEL_LINE_LENGTH = 9;

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
