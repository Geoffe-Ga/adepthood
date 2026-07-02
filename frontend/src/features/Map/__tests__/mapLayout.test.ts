/* eslint-env jest */
/* global describe, it, expect */
import {
  GRID_COLUMN_FLEX,
  MAP_ROWS,
  MAP_TITLE_LINES,
  RIGHT_LABEL_MIN_FONT_SCALE,
  STAGE_DISPLAY,
} from '../mapLayout';
import { STAGE_COUNT } from '../stageData';

const HEX_COLOR = /^#[\da-f]{6}$/i;
const ALL_STAGES = Array.from({ length: STAGE_COUNT }, (_, i) => STAGE_COUNT - i);

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

  it('keeps the right-label font-scale floor within the auto-fit range', () => {
    expect(RIGHT_LABEL_MIN_FONT_SCALE).toBeGreaterThan(0);
    expect(RIGHT_LABEL_MIN_FONT_SCALE).toBeLessThan(1);
  });

  it('keeps the shared column-flex weights the wave geometry also depends on', () => {
    expect(GRID_COLUMN_FLEX).toEqual({ left: 2, center: 2, right: 1 });
  });
});
