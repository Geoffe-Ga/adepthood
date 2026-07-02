/* eslint-env jest */
/* global describe, it, expect */
import { STAGE_DISPLAY } from '../mapLayout';
import { STAGE_COUNT, isLeftReturning } from '../stageData';
import {
  arrowheadAt,
  centerColumnBounds,
  nominalAnchorY,
  stageWavePoint,
  waveArrowheads,
  waveSegments,
} from '../waveGeometry';
import type { StageAnchors, WaveSegment } from '../waveGeometry';

const CENTER_X = 0.5;
const CONVERGENCE_EPSILON = 0.05;
const UNIT_MIN = 0;
const UNIT_MAX = 1;
const SEGMENT_COUNT = STAGE_COUNT - 1;
const SMALL_WIDTH = 100;
const SMALL_HEIGHT = 200;
const LARGE_WIDTH = 200;
const LARGE_HEIGHT = 400;
const REPRESENTATIVE_STAGE = 4;

const PHONE_WIDTHS = [320, 375, 393, 430];
const REPRESENTATIVE_HEIGHT = 800;

const WAVE_STROKE_HALF_WIDTH = 1.5;
const HALF_ARROWHEAD_WIDTH = 6;
const SAFE_MARGIN_PX = WAVE_STROKE_HALF_WIDTH + HALF_ARROWHEAD_WIDTH;

const LEFT_COLUMN_FLEX = 2;
const CENTER_COLUMN_FLEX = 2;
const RIGHT_COLUMN_FLEX = 1;
const TOTAL_COLUMN_FLEX = LEFT_COLUMN_FLEX + CENTER_COLUMN_FLEX + RIGHT_COLUMN_FLEX;
const CENTER_LEFT_FRACTION = LEFT_COLUMN_FLEX / TOTAL_COLUMN_FLEX;
const CENTER_RIGHT_FRACTION = (LEFT_COLUMN_FLEX + CENTER_COLUMN_FLEX) / TOTAL_COLUMN_FLEX;

const WOBBLE_VISIBILITY_FRACTION = 0.4;
const LEFT_WOBBLE_STAGE = 2;
const RIGHT_WOBBLE_STAGE = 1;

// x tokens in the "M x1 y1 C x1 mY x2 mY x2 y2" segment path stream.
const SEGMENT_X_TOKEN_INDICES = [1, 4, 6, 8];
const segmentPathXs = (d: string): number[] => {
  const tokens = d.trim().split(' ');
  return SEGMENT_X_TOKEN_INDICES.map((index) => Number(tokens[index]));
};

const arrowheadXs = (points: string): number[] =>
  points
    .trim()
    .split(' ')
    .map((pair) => pair.split(',').map(Number))
    .map(([x]) => x as number);

describe('stageWavePoint', () => {
  it('rises upward: y strictly decreases as stageNumber climbs from 1 to 10', () => {
    const ys = Array.from({ length: STAGE_COUNT }, (_, i) => stageWavePoint(i + 1).y);
    for (let stage = 2; stage <= STAGE_COUNT; stage += 1) {
      expect(stageWavePoint(stage).y).toBeLessThan(stageWavePoint(stage - 1).y);
    }
    expect(ys).toHaveLength(STAGE_COUNT);
  });

  it('wobbles left for even (WE) stages and right for odd (I) stages, stages 1-8', () => {
    for (let stage = 1; stage <= 8; stage += 1) {
      const { x } = stageWavePoint(stage);
      if (isLeftReturning(stage)) {
        expect(x).toBeLessThan(CENTER_X);
      } else {
        expect(x).toBeGreaterThan(CENTER_X);
      }
    }
  });

  it('converges toward center for stages 9-10, tighter than stage 8', () => {
    const offset8 = Math.abs(stageWavePoint(8).x - CENTER_X);
    const offset9 = Math.abs(stageWavePoint(9).x - CENTER_X);
    const offset10 = Math.abs(stageWavePoint(10).x - CENTER_X);
    expect(offset10).toBeLessThan(offset9);
    expect(offset9).toBeLessThan(offset8);
    expect(offset10).toBeLessThan(CONVERGENCE_EPSILON);
  });

  it('keeps every stage point within unit space [0,1] for x and y', () => {
    for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
      const { x, y } = stageWavePoint(stage);
      expect(x).toBeGreaterThanOrEqual(UNIT_MIN);
      expect(x).toBeLessThanOrEqual(UNIT_MAX);
      expect(y).toBeGreaterThanOrEqual(UNIT_MIN);
      expect(y).toBeLessThanOrEqual(UNIT_MAX);
    }
  });

  it('reports pole -1 for even stages and +1 for odd stages, 1-8', () => {
    for (let stage = 1; stage <= 8; stage += 1) {
      const expected = isLeftReturning(stage) ? -1 : 1;
      expect(stageWavePoint(stage).pole).toBe(expected);
    }
  });

  it('reports pole 0 at the converged top, stage 10', () => {
    expect(stageWavePoint(10).pole).toBe(0);
  });
});

describe('waveSegments', () => {
  it('returns exactly STAGE_COUNT-1 segments', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    expect(segments).toHaveLength(SEGMENT_COUNT);
  });

  it('assigns each segment the lower stage number of the pair it connects', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    const stageNumbers = segments.map((s) => s.stageNumber).sort((a, b) => a - b);
    expect(stageNumbers).toEqual(Array.from({ length: SEGMENT_COUNT }, (_, i) => i + 1));
  });

  it('colors each segment with the lower stage textColor from STAGE_DISPLAY', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    for (const segment of segments) {
      expect(segment.color).toBe(STAGE_DISPLAY[segment.stageNumber]?.textColor);
    }
  });

  it('produces a non-empty path string for every segment', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    for (const segment of segments) {
      expect(segment.d.length).toBeGreaterThan(0);
    }
  });

  it('scales the path coordinates with width and height', () => {
    const small = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    const large = waveSegments(LARGE_WIDTH, LARGE_HEIGHT);
    for (let i = 0; i < small.length; i += 1) {
      expect(large[i]?.d).not.toBe(small[i]?.d);
    }
  });
});

describe('arrowheadAt', () => {
  it('points upward: apex y is above (smaller than) the base y in pixel space', () => {
    const arrow = arrowheadAt(REPRESENTATIVE_STAGE, SMALL_WIDTH, SMALL_HEIGHT);
    const coordinatePairs = arrow.points
      .trim()
      .split(' ')
      .map((pair) => pair.split(',').map(Number));
    const ys = coordinatePairs.map(([, y]) => y as number);
    const apexY = Math.min(...ys);
    const baseY = Math.max(...ys);
    expect(apexY).toBeLessThan(baseY);
  });
});

describe('center-column containment', () => {
  const findSegmentX = (segments: readonly WaveSegment[], stageNumber: number): number => {
    for (const segment of segments) {
      if (segment.stageNumber === stageNumber) {
        const xs = segmentPathXs(segment.d);
        return xs[0] as number;
      }
    }
    throw new Error(`no segment found for stage ${stageNumber}`);
  };

  it('reports center-column bounds as flex-derived fractions of width', () => {
    for (const width of PHONE_WIDTHS) {
      const bounds = centerColumnBounds(width);
      expect(bounds.left).toBeCloseTo(CENTER_LEFT_FRACTION * width);
      expect(bounds.right).toBeCloseTo(CENTER_RIGHT_FRACTION * width);
    }
  });

  it('keeps every wave-segment x-coordinate within the margin-shrunk center column', () => {
    for (const width of PHONE_WIDTHS) {
      const { left, right } = centerColumnBounds(width);
      const minX = left + SAFE_MARGIN_PX;
      const maxX = right - SAFE_MARGIN_PX;
      const segments = waveSegments(width, REPRESENTATIVE_HEIGHT);
      for (const segment of segments) {
        for (const x of segmentPathXs(segment.d)) {
          expect(x).toBeGreaterThanOrEqual(minX);
          expect(x).toBeLessThanOrEqual(maxX);
        }
      }
    }
  });

  it('keeps every arrowhead vertex x-coordinate within the margin-shrunk center column', () => {
    for (const width of PHONE_WIDTHS) {
      const { left, right } = centerColumnBounds(width);
      const minX = left + SAFE_MARGIN_PX;
      const maxX = right - SAFE_MARGIN_PX;
      const arrowheads = waveArrowheads(width, REPRESENTATIVE_HEIGHT);
      for (const arrowhead of arrowheads) {
        for (const x of arrowheadXs(arrowhead.points)) {
          expect(x).toBeGreaterThanOrEqual(minX);
          expect(x).toBeLessThanOrEqual(maxX);
        }
      }
    }
  });

  it('keeps the wobble visible: full-amplitude stages swing past 0.4 of the column half-width', () => {
    for (const width of PHONE_WIDTHS) {
      const { left, right } = centerColumnBounds(width);
      const columnMidline = (left + right) / 2;
      const columnHalfWidth = (right - left) / 2;
      const segments = waveSegments(width, REPRESENTATIVE_HEIGHT);
      const leftX = findSegmentX(segments, LEFT_WOBBLE_STAGE);
      const rightX = findSegmentX(segments, RIGHT_WOBBLE_STAGE);
      expect(Math.abs(leftX - columnMidline)).toBeGreaterThanOrEqual(
        WOBBLE_VISIBILITY_FRACTION * columnHalfWidth,
      );
      expect(Math.abs(rightX - columnMidline)).toBeGreaterThanOrEqual(
        WOBBLE_VISIBILITY_FRACTION * columnHalfWidth,
      );
    }
  });
});

describe('measured anchors: nominal fallback and pixel-space threading', () => {
  const NOMINAL_BAND_MIDPOINT = 0.5;
  const OVERRIDE_STAGE = 4;
  const OVERRIDE_UNIT_Y = 0.42;
  const NON_UNIFORM_ANCHORS: StageAnchors = {
    1: 0.94,
    2: 0.83,
    3: 0.76,
    4: 0.68,
    5: 0.57,
    6: 0.49,
    7: 0.39,
    8: 0.31,
    9: 0.18,
    10: 0.06,
  };
  const SEGMENT_Y1_TOKEN_INDEX = 2;
  const SEGMENT_Y2_TOKEN_INDEX = 9;
  const ANCHOR_COORD_PRECISION = 3;
  const EXPECTED_ARROWHEAD_HEIGHT = 10;

  const findSegment = (segments: readonly WaveSegment[], stageNumber: number): WaveSegment => {
    const segment = segments.find((s) => s.stageNumber === stageNumber);
    if (!segment) throw new Error(`no segment found for stage ${stageNumber}`);
    return segment;
  };

  it('nominalAnchorY matches the legacy uniform-band formula for every stage', () => {
    for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
      const expected = (STAGE_COUNT - stage + NOMINAL_BAND_MIDPOINT) / STAGE_COUNT;
      expect(nominalAnchorY(stage)).toBeCloseTo(expected);
    }
  });

  it('stageWavePoint(n) matches stageWavePoint(n, {}) for every stage', () => {
    for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
      expect(stageWavePoint(stage, {})).toEqual(stageWavePoint(stage));
    }
  });

  it('a measured override wins for its own stage; every other stage falls back to nominalAnchorY', () => {
    const anchors: StageAnchors = { [OVERRIDE_STAGE]: OVERRIDE_UNIT_Y };
    expect(stageWavePoint(OVERRIDE_STAGE, anchors).y).toBe(OVERRIDE_UNIT_Y);
    for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
      if (stage === OVERRIDE_STAGE) continue;
      const { y } = stageWavePoint(stage, anchors);
      expect(Number.isNaN(y)).toBe(false);
      expect(y).toBe(nominalAnchorY(stage));
    }
  });

  it('non-uniform anchors flow into segment endpoints in pixel space', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT, NON_UNIFORM_ANCHORS);
    for (let stage = 1; stage <= SEGMENT_COUNT; stage += 1) {
      const segment = findSegment(segments, stage);
      const tokens = segment.d.trim().split(' ');
      const expectedY1 = ((NON_UNIFORM_ANCHORS[stage] ?? 0) * SMALL_HEIGHT).toFixed(
        ANCHOR_COORD_PRECISION,
      );
      const expectedY2 = ((NON_UNIFORM_ANCHORS[stage + 1] ?? 0) * SMALL_HEIGHT).toFixed(
        ANCHOR_COORD_PRECISION,
      );
      expect(tokens[SEGMENT_Y1_TOKEN_INDEX]).toBe(expectedY1);
      expect(tokens[SEGMENT_Y2_TOKEN_INDEX]).toBe(expectedY2);
    }
  });

  it('centers the arrowhead triangle exactly on the resolved anchor', () => {
    const arrow = arrowheadAt(REPRESENTATIVE_STAGE, SMALL_WIDTH, SMALL_HEIGHT, NON_UNIFORM_ANCHORS);
    const coordinatePairs = arrow.points
      .trim()
      .split(' ')
      .map((pair) => pair.split(',').map(Number));
    const ys = coordinatePairs.map(([, y]) => y as number);
    const apexY = Math.min(...ys);
    const baseY = Math.max(...ys);
    const expectedCenter = (NON_UNIFORM_ANCHORS[REPRESENTATIVE_STAGE] ?? 0) * SMALL_HEIGHT;
    expect((apexY + baseY) / 2).toBeCloseTo(expectedCenter);
    expect(baseY - apexY).toBe(EXPECTED_ARROWHEAD_HEIGHT);
  });

  it('colors stay keyed to STAGE_DISPLAY textColor when anchors are non-uniform', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT, NON_UNIFORM_ANCHORS);
    for (const segment of segments) {
      expect(segment.color).toBe(STAGE_DISPLAY[segment.stageNumber]?.textColor);
    }
    const arrowheads = waveArrowheads(SMALL_WIDTH, SMALL_HEIGHT, NON_UNIFORM_ANCHORS);
    for (const arrowhead of arrowheads) {
      expect(arrowhead.color).toBe(STAGE_DISPLAY[arrowhead.stageNumber]?.textColor);
    }
  });

  const expectXsWithin = (xs: number[], minX: number, maxX: number): void => {
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(x).toBeLessThanOrEqual(maxX);
    }
  };

  it('keeps x-coordinates within the margin-shrunk center column when anchors are non-uniform', () => {
    for (const width of PHONE_WIDTHS) {
      const { left, right } = centerColumnBounds(width);
      const minX = left + SAFE_MARGIN_PX;
      const maxX = right - SAFE_MARGIN_PX;
      const segments = waveSegments(width, REPRESENTATIVE_HEIGHT, NON_UNIFORM_ANCHORS);
      for (const segment of segments) expectXsWithin(segmentPathXs(segment.d), minX, maxX);
      const arrowheads = waveArrowheads(width, REPRESENTATIVE_HEIGHT, NON_UNIFORM_ANCHORS);
      for (const arrowhead of arrowheads) expectXsWithin(arrowheadXs(arrowhead.points), minX, maxX);
    }
  });
});
