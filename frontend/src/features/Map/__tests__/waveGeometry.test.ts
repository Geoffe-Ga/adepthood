/* eslint-env jest */
/* global describe, it, expect */
import { STAGE_DISPLAY } from '../mapLayout';
import { STAGE_COUNT, isLeftReturning } from '../stageData';
import { arrowheadAt, stageWavePoint, waveSegments } from '../waveGeometry';

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

/** Reads the number at ``index`` out of a parsed coordinate list. */
const numberAt = (numbers: readonly number[], index: number): number => numbers[index] as number;

/** The leading "M x y" and trailing "x y" point of an SVG path string. */
const parsePathPoints = (d: string): { first: [number, number]; last: [number, number] } => {
  const matches = d.match(/-?\d+\.?\d*/g);
  const numbers = matches === null ? [] : matches.map(Number);
  const lastIndex = numbers.length - 1;
  return {
    first: [numberAt(numbers, 0), numberAt(numbers, 1)],
    last: [numberAt(numbers, lastIndex - 1), numberAt(numbers, lastIndex)],
  };
};

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

  it('gives every segment a non-empty farD distinct from its near-side d', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    for (const segment of segments) {
      expect(segment.farD.length).toBeGreaterThan(0);
      expect(segment.farD).not.toBe(segment.d);
    }
  });

  it('mirrors farD across the column center: far x = width - near x, y unchanged', () => {
    const segments = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    for (const segment of segments) {
      const near = parsePathPoints(segment.d);
      const far = parsePathPoints(segment.farD);
      expect(far.first[0]).toBeCloseTo(SMALL_WIDTH - near.first[0], 2);
      expect(far.first[1]).toBeCloseTo(near.first[1], 2);
      expect(far.last[0]).toBeCloseTo(SMALL_WIDTH - near.last[0], 2);
      expect(far.last[1]).toBeCloseTo(near.last[1], 2);
    }
  });

  it('scales farD coordinates with width and height like d', () => {
    const small = waveSegments(SMALL_WIDTH, SMALL_HEIGHT);
    const large = waveSegments(LARGE_WIDTH, LARGE_HEIGHT);
    for (let i = 0; i < small.length; i += 1) {
      expect(large[i]?.farD).not.toBe(small[i]?.farD);
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
