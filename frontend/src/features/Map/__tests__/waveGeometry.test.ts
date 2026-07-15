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
const TOTAL_SEGMENT_COUNT = SEGMENT_COUNT * 2;
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

// Coordinate rounding precision shared with waveGeometry's own roundCoord.
const COORD_PRECISION = 3;

// Each half's path is "M x y C cx1 cy1 cx2 cy2 x y"; these are its x-token slots.
const START_X_TOKEN_INDEX = 1;
const CONTROL1_X_TOKEN_INDEX = 4;
const CONTROL2_X_TOKEN_INDEX = 6;
const END_X_TOKEN_INDEX = 8;
const SEGMENT_X_TOKEN_INDICES = [
  START_X_TOKEN_INDEX,
  CONTROL1_X_TOKEN_INDEX,
  CONTROL2_X_TOKEN_INDEX,
  END_X_TOKEN_INDEX,
];
const SEGMENT_Y1_TOKEN_INDEX = 2;
const SEGMENT_Y2_TOKEN_INDEX = 9;

const HALF_LOWER = 'lower';
const HALF_UPPER = 'upper';

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

// Pixel x for a unit x within the center column, derived via the same exported
// column fractions waveGeometry uses internally, so expectations never hardcode
// magic pixel numbers.
const toPixelX = (unitX: number, width: number): number => {
  const { left, right } = centerColumnBounds(width);
  return left + unitX * (right - left);
};

const findHalf = (
  segments: readonly WaveSegment[],
  stageNumber: number,
  half: WaveSegment['half'],
): WaveSegment => {
  const segment = segments.find((s) => s.stageNumber === stageNumber && s.half === half);
  if (!segment) throw new Error(`no ${half} half found for pair stage ${stageNumber}`);
  return segment;
};

interface PairPixelEndpoints {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

// The pair's raw (pre-split) pixel endpoints, derived from stageWavePoint the
// same way waveSegments builds its bezier.
const pairPixelEndpoints = (
  pairStage: number,
  width: number,
  height: number,
  anchors: StageAnchors = {},
): PairPixelEndpoints => {
  const lowerPoint = stageWavePoint(pairStage, anchors);
  const upperPoint = stageWavePoint(pairStage + 1, anchors);
  return {
    x1: toPixelX(lowerPoint.x, width),
    x2: toPixelX(upperPoint.x, width),
    y1: lowerPoint.y * height,
    y2: upperPoint.y * height,
  };
};

describe('stageWavePoint', () => {
  it('rises upward: y strictly decreases as stageNumber climbs from 1 to 10', () => {
    for (let stage = 2; stage <= STAGE_COUNT; stage += 1) {
      expect(stageWavePoint(stage).y).toBeLessThan(stageWavePoint(stage - 1).y);
    }
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

  it('tapers the horizontal offset strictly monotonically as stage rises from 1 to 10', () => {
    const offsetAt = (stage: number): number => Math.abs(stageWavePoint(stage).x - CENTER_X);
    for (let stage = 2; stage <= STAGE_COUNT; stage += 1) {
      expect(offsetAt(stage)).toBeLessThan(offsetAt(stage - 1));
    }
  });

  it('spans stage 1 (widest offset) to stage 10 (non-degenerate apex)', () => {
    const offset1 = Math.abs(stageWavePoint(1).x - CENTER_X);
    const offset10 = Math.abs(stageWavePoint(10).x - CENTER_X);
    expect(offset1).toBeCloseTo(0.32, 2);
    expect(offset10).toBeGreaterThan(0);
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
});

describe('waveSegments', () => {
  it('returns exactly 2*(STAGE_COUNT-1) segments, a lower and an upper half per pair', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    expect(segments).toHaveLength(TOTAL_SEGMENT_COUNT);
  });

  it('assigns each pair stage number 1..9 to exactly two segments (one lower, one upper half)', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    const stageNumbers = segments.map((s) => s.stageNumber).sort((a, b) => a - b);
    const expectedStageNumbers = Array.from({ length: SEGMENT_COUNT }, (_, i) => i + 1)
      .flatMap((stage) => [stage, stage])
      .sort((a, b) => a - b);
    expect(stageNumbers).toEqual(expectedStageNumbers);
  });

  it('colors the lower half with its own stage and the upper half with the next stage', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    for (const segment of segments) {
      const colorStage =
        segment.half === HALF_LOWER ? segment.stageNumber : segment.stageNumber + 1;
      expect(segment.color).toBe(STAGE_DISPLAY[colorStage]?.textColor);
    }
  });

  it('produces a non-empty path string for every segment half', () => {
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

describe('waveSegments color phase: boundary colors land on the wave outside edges', () => {
  it('colors both halves meeting at each interior anchor (stage 2..9) with that anchor stage color', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    for (let stage = 2; stage <= SEGMENT_COUNT; stage += 1) {
      const endingHere = findHalf(segments, stage - 1, HALF_UPPER);
      const startingHere = findHalf(segments, stage, HALF_LOWER);
      const expectedColor = STAGE_DISPLAY[stage]?.textColor;
      expect(endingHere.color).toBe(expectedColor);
      expect(startingHere.color).toBe(expectedColor);
    }
  });

  it('colors the opening lower half with stage 1 color', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    const opening = findHalf(segments, 1, HALF_LOWER);
    expect(opening.color).toBe(STAGE_DISPLAY[1]?.textColor);
  });

  it('colors the final upper half with the STAGE_COUNT stage color', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    const final = findHalf(segments, SEGMENT_COUNT, HALF_UPPER);
    expect(final.color).toBe(STAGE_DISPLAY[STAGE_COUNT]?.textColor);
  });
});

describe('waveSegments identity: exactly one lower and one upper half per pair', () => {
  it('every pair 1..9 yields exactly one lower half and one upper half', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    for (let pair = 1; pair <= SEGMENT_COUNT; pair += 1) {
      const lowerHalves = segments.filter((s) => s.stageNumber === pair && s.half === HALF_LOWER);
      const upperHalves = segments.filter((s) => s.stageNumber === pair && s.half === HALF_UPPER);
      expect(lowerHalves).toHaveLength(1);
      expect(upperHalves).toHaveLength(1);
    }
  });

  it('all 18 (stageNumber, half) identities are unique', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    const identities = segments.map((s) => `${s.stageNumber}-${s.half}`);
    expect(new Set(identities).size).toBe(TOTAL_SEGMENT_COUNT);
  });
});

describe('waveSegments split geometry: de Casteljau midline split', () => {
  const scenarios: ReadonlyArray<{ label: string; anchors: StageAnchors }> = [
    { label: 'nominal anchors', anchors: {} },
    { label: 'non-uniform anchors', anchors: NON_UNIFORM_ANCHORS },
  ];

  for (const { label, anchors } of scenarios) {
    it(`splits the pair bezier so the lower half ends and the upper half starts at the shared seam (${label})`, () => {
      const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT, anchors);
      const lowerHalf = findHalf(segments, REPRESENTATIVE_STAGE, HALF_LOWER);
      const upperHalf = findHalf(segments, REPRESENTATIVE_STAGE, HALF_UPPER);
      const { x1, x2, y1, y2 } = pairPixelEndpoints(
        REPRESENTATIVE_STAGE,
        SMALL_WIDTH,
        SMALL_HEIGHT,
        anchors,
      );
      const seamX = ((x1 + x2) / 2).toFixed(COORD_PRECISION);
      const seamY = ((y1 + y2) / 2).toFixed(COORD_PRECISION);
      const lowerTokens = lowerHalf.d.trim().split(' ');
      const upperTokens = upperHalf.d.trim().split(' ');
      expect(lowerTokens[END_X_TOKEN_INDEX]).toBe(seamX);
      expect(lowerTokens[SEGMENT_Y2_TOKEN_INDEX]).toBe(seamY);
      expect(upperTokens[START_X_TOKEN_INDEX]).toBe(seamX);
      expect(upperTokens[SEGMENT_Y1_TOKEN_INDEX]).toBe(seamY);
      expect(lowerTokens[END_X_TOKEN_INDEX]).toBe(upperTokens[START_X_TOKEN_INDEX]);
      expect(lowerTokens[SEGMENT_Y2_TOKEN_INDEX]).toBe(upperTokens[SEGMENT_Y1_TOKEN_INDEX]);
    });

    it(`places the de Casteljau interior control-point x values at the correct convex combinations (${label})`, () => {
      const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT, anchors);
      const lowerHalf = findHalf(segments, REPRESENTATIVE_STAGE, HALF_LOWER);
      const upperHalf = findHalf(segments, REPRESENTATIVE_STAGE, HALF_UPPER);
      const { x1, x2 } = pairPixelEndpoints(
        REPRESENTATIVE_STAGE,
        SMALL_WIDTH,
        SMALL_HEIGHT,
        anchors,
      );
      const lowerTokens = lowerHalf.d.trim().split(' ');
      const upperTokens = upperHalf.d.trim().split(' ');
      const lowerControl1X = Number(lowerTokens[CONTROL1_X_TOKEN_INDEX]);
      const lowerControl2X = Number(lowerTokens[CONTROL2_X_TOKEN_INDEX]);
      const upperControl1X = Number(upperTokens[CONTROL1_X_TOKEN_INDEX]);
      const upperControl2X = Number(upperTokens[CONTROL2_X_TOKEN_INDEX]);
      expect(lowerControl1X).toBeCloseTo(x1, COORD_PRECISION);
      expect(lowerControl2X).toBeCloseTo((3 * x1 + x2) / 4, COORD_PRECISION);
      expect(upperControl1X).toBeCloseTo((x1 + 3 * x2) / 4, COORD_PRECISION);
      expect(upperControl2X).toBeCloseTo(x2, COORD_PRECISION);
    });
  }
});

describe('waveSegments continuity across the split wave', () => {
  const startCoord = (segment: WaveSegment): string => {
    const tokens = segment.d.trim().split(' ');
    return `${tokens[START_X_TOKEN_INDEX]} ${tokens[SEGMENT_Y1_TOKEN_INDEX]}`;
  };
  const endCoord = (segment: WaveSegment): string => {
    const tokens = segment.d.trim().split(' ');
    return `${tokens[END_X_TOKEN_INDEX]} ${tokens[SEGMENT_Y2_TOKEN_INDEX]}`;
  };

  it("the lower half's end matches the upper half's start at the seam, for every pair", () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    for (let pair = 1; pair <= SEGMENT_COUNT; pair += 1) {
      const lowerHalf = findHalf(segments, pair, HALF_LOWER);
      const upperHalf = findHalf(segments, pair, HALF_UPPER);
      expect(endCoord(lowerHalf)).toBe(startCoord(upperHalf));
    }
  });

  it("a pair's upper-half end matches the next pair's lower-half start at the shared anchor", () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    for (let pair = 1; pair < SEGMENT_COUNT; pair += 1) {
      const upperHalf = findHalf(segments, pair, HALF_UPPER);
      const nextLowerHalf = findHalf(segments, pair + 1, HALF_LOWER);
      expect(endCoord(upperHalf)).toBe(startCoord(nextLowerHalf));
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
      if (segment.stageNumber === stageNumber && segment.half === HALF_LOWER) {
        const xs = segmentPathXs(segment.d);
        return xs[0] as number;
      }
    }
    throw new Error(`no lower-half segment found for stage ${stageNumber}`);
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
  const EXPECTED_ARROWHEAD_HEIGHT = 10;

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

  it('non-uniform anchors flow into split segment endpoints in pixel space', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT, NON_UNIFORM_ANCHORS);
    for (let stage = 1; stage <= SEGMENT_COUNT; stage += 1) {
      const lowerHalf = findHalf(segments, stage, HALF_LOWER);
      const upperHalf = findHalf(segments, stage, HALF_UPPER);
      const lowerTokens = lowerHalf.d.trim().split(' ');
      const upperTokens = upperHalf.d.trim().split(' ');
      const anchorY1 = (NON_UNIFORM_ANCHORS[stage] ?? 0) * SMALL_HEIGHT;
      const anchorY2 = (NON_UNIFORM_ANCHORS[stage + 1] ?? 0) * SMALL_HEIGHT;
      const seamY = ((anchorY1 + anchorY2) / 2).toFixed(COORD_PRECISION);
      expect(lowerTokens[SEGMENT_Y1_TOKEN_INDEX]).toBe(anchorY1.toFixed(COORD_PRECISION));
      expect(lowerTokens[SEGMENT_Y2_TOKEN_INDEX]).toBe(seamY);
      expect(upperTokens[SEGMENT_Y1_TOKEN_INDEX]).toBe(seamY);
      expect(upperTokens[SEGMENT_Y2_TOKEN_INDEX]).toBe(anchorY2.toFixed(COORD_PRECISION));
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
      const colorStage =
        segment.half === HALF_LOWER ? segment.stageNumber : segment.stageNumber + 1;
      expect(segment.color).toBe(STAGE_DISPLAY[colorStage]?.textColor);
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
