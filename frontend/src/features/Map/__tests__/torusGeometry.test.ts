/* eslint-env jest */
/* global describe, it, expect */
import { SPIRAL_SAMPLE_COUNT, TORUS_RING_COUNT, spiralPath, torusRings } from '../torusGeometry';

const SMALL_WIDTH = 100;
const SMALL_HEIGHT = 200;
const LARGE_WIDTH = 200;
const LARGE_HEIGHT = 400;
const MAX_DECIMALS = 3;
const COORDS_PER_POINT = 2;
const Y_OFFSET = 1;

/** Every numeric token in an SVG path string, in order, ignoring the letters. */
const numbersIn = (path: string): number[] =>
  path
    .split(/[\s,]+/)
    .map(Number)
    .filter((value) => !Number.isNaN(value));

/** Whether a number carries no more than MAX_DECIMALS fractional digits. */
const hasBoundedPrecision = (value: number): boolean => {
  const fraction = String(value).split('.')[1] ?? '';
  return fraction.length <= MAX_DECIMALS;
};

describe('torusRings', () => {
  it('returns exactly TORUS_RING_COUNT rings', () => {
    expect(torusRings(SMALL_WIDTH, SMALL_HEIGHT)).toHaveLength(TORUS_RING_COUNT);
  });

  it('emits a non-empty arc path beginning with a move command for every ring', () => {
    for (const ring of torusRings(SMALL_WIDTH, SMALL_HEIGHT)) {
      expect(ring.d.length).toBeGreaterThan(0);
      expect(ring.d.startsWith('M')).toBe(true);
    }
  });

  it('keeps every emitted number finite and within three decimals', () => {
    for (const ring of torusRings(SMALL_WIDTH, SMALL_HEIGHT)) {
      for (const value of numbersIn(ring.d)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(hasBoundedPrecision(value)).toBe(true);
      }
    }
  });

  it('keeps every ring number non-negative and within the layout extent', () => {
    const bound = Math.max(SMALL_WIDTH, SMALL_HEIGHT);
    for (const ring of torusRings(SMALL_WIDTH, SMALL_HEIGHT)) {
      for (const value of numbersIn(ring.d)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('scales the ring coordinates with width and height', () => {
    const small = torusRings(SMALL_WIDTH, SMALL_HEIGHT);
    const large = torusRings(LARGE_WIDTH, LARGE_HEIGHT);
    for (let index = 0; index < small.length; index += 1) {
      expect(large[index]?.d).not.toBe(small[index]?.d);
    }
  });
});

describe('spiralPath', () => {
  it('emits a non-empty polyline beginning with a move command', () => {
    const path = spiralPath(SMALL_WIDTH, SMALL_HEIGHT);
    expect(path.length).toBeGreaterThan(0);
    expect(path.startsWith('M')).toBe(true);
  });

  it('samples SPIRAL_SAMPLE_COUNT points', () => {
    const numbers = numbersIn(spiralPath(SMALL_WIDTH, SMALL_HEIGHT));
    expect(numbers).toHaveLength(SPIRAL_SAMPLE_COUNT * COORDS_PER_POINT);
  });

  it('rises: the first sampled point sits below the last (larger y to smaller y)', () => {
    const numbers = numbersIn(spiralPath(SMALL_WIDTH, SMALL_HEIGHT));
    const firstY = numbers[Y_OFFSET] ?? 0;
    const lastY = numbers[numbers.length - 1] ?? 0;
    expect(firstY).toBeGreaterThan(lastY);
  });

  it('keeps every sampled point inside the layout bounds', () => {
    const numbers = numbersIn(spiralPath(SMALL_WIDTH, SMALL_HEIGHT));
    for (let index = 0; index < numbers.length; index += COORDS_PER_POINT) {
      const x = numbers[index] ?? 0;
      const y = numbers[index + Y_OFFSET] ?? 0;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(SMALL_WIDTH);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(SMALL_HEIGHT);
    }
  });

  it('scales the spiral coordinates with width and height', () => {
    expect(spiralPath(LARGE_WIDTH, LARGE_HEIGHT)).not.toBe(spiralPath(SMALL_WIDTH, SMALL_HEIGHT));
  });
});
