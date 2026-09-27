/* global describe, it, expect */
import {
  insideBox,
  insideViewport,
  STROKE_CLEARANCE_TOLERANCE_PX,
  strokeHits,
  WAVE_SAMPLE_STEP_PX,
  within,
  withoutCovers,
  type Point,
} from '../../../e2e/mapGeometry';
import { SUBPIXEL_TOLERANCE, type Box, type TextRecord } from '../../../e2e/textCensus';

/**
 * The Map legibility spec (#2657) measures the wave stroke and the stage
 * annotations in Chromium, then judges them with these predicates in Node. A
 * predicate that quietly reported nothing would certify a Map it never
 * measured, so each one is pinned here on synthetic geometry -- at its exact
 * boundary, where an off-by-one or a dropped half-stroke would otherwise pass.
 */

const HALF_STROKE = 1.5;
const TOLERANCE = STROKE_CLEARANCE_TOLERANCE_PX;
/** Clearance the stroke's paint needs to intrude by more than the tolerance. */
const HIT_DISTANCE = HALF_STROKE - TOLERANCE;
const ONE_PX = 1;
/** Off both edges by this much: under the clearance per axis, over it diagonally. */
const DIAGONAL_OFFSET = 0.4;

const BOX: Box = { x: 100, y: 100, w: 40, h: 10 };
const RIGHT_EDGE = BOX.x + BOX.w;
const BOTTOM_EDGE = BOX.y + BOX.h;
const MID_Y = BOX.y + BOX.h / 2;
const MID_X = BOX.x + BOX.w / 2;

describe('the Map legibility constants', () => {
  it('allows the stroke no more intrusion than the census allows text', () => {
    expect(STROKE_CLEARANCE_TOLERANCE_PX).toBe(SUBPIXEL_TOLERANCE);
  });

  it('samples the wave finely enough that a 3px stroke cannot slip between samples', () => {
    expect(WAVE_SAMPLE_STEP_PX).toBeGreaterThan(0);
    expect(WAVE_SAMPLE_STEP_PX).toBeLessThanOrEqual(2);
  });
});

describe('strokeHits', () => {
  it('treats a sample exactly at the clearance boundary as a miss and one pixel closer as a hit', () => {
    const atBoundary: Point = { x: RIGHT_EDGE + HIT_DISTANCE, y: MID_Y };
    const closer: Point = { x: RIGHT_EDGE + HIT_DISTANCE - ONE_PX, y: MID_Y };

    expect(strokeHits(BOX, [atBoundary], HALF_STROKE, TOLERANCE)).toEqual([]);
    expect(strokeHits(BOX, [closer], HALF_STROKE, TOLERANCE)).toEqual([closer]);
  });

  it('inflates each sample by half the stroke width, not the whole of it', () => {
    // Clear of a half-stroke inflation, but inside a full-stroke one.
    const between: Point = { x: MID_X, y: BOTTOM_EDGE + HIT_DISTANCE + HALF_STROKE / 2 };

    expect(strokeHits(BOX, [between], HALF_STROKE, TOLERANCE)).toEqual([]);
    expect(strokeHits(BOX, [between], HALF_STROKE * 2, TOLERANCE)).toEqual([between]);
  });

  it('hits a sample inside the box on every side, and misses ones clear of every side', () => {
    const inside: Point = { x: MID_X, y: MID_Y };
    const clear: Point[] = [
      { x: BOX.x - HALF_STROKE, y: MID_Y },
      { x: RIGHT_EDGE + HALF_STROKE, y: MID_Y },
      { x: MID_X, y: BOX.y - HALF_STROKE },
      { x: MID_X, y: BOTTOM_EDGE + HALF_STROKE },
    ];
    const grazing: Point[] = [
      { x: BOX.x, y: MID_Y },
      { x: RIGHT_EDGE, y: MID_Y },
      { x: MID_X, y: BOX.y },
      { x: MID_X, y: BOTTOM_EDGE },
    ];

    expect(strokeHits(BOX, [inside], HALF_STROKE, TOLERANCE)).toEqual([inside]);
    expect(strokeHits(BOX, clear, HALF_STROKE, TOLERANCE)).toEqual([]);
    expect(strokeHits(BOX, grazing, HALF_STROKE, TOLERANCE)).toEqual(grazing);
  });

  it('measures a corner sample by its true distance, not per axis', () => {
    // 0.4px off both edges is ~0.57px from the corner: clear of a 0.5px
    // clearance, though a per-axis check would call it a hit.
    const diagonal: Point = { x: RIGHT_EDGE + DIAGONAL_OFFSET, y: BOTTOM_EDGE + DIAGONAL_OFFSET };

    expect(strokeHits(BOX, [diagonal], HALF_STROKE, TOLERANCE)).toEqual([]);
  });

  it('reports nothing when there is nothing to sample', () => {
    expect(strokeHits(BOX, [], HALF_STROKE, TOLERANCE)).toEqual([]);
  });
});

describe('insideBox', () => {
  const OUTER: Box = { x: 0, y: 0, w: 100, h: 50 };

  it('accepts a box flush with every edge', () => {
    expect(insideBox(OUTER, OUTER, 0)).toBe(true);
  });

  it.each([
    ['left', { x: -2, y: 10, w: 10, h: 10 }],
    ['top', { x: 10, y: -2, w: 10, h: 10 }],
    ['right', { x: 92, y: 10, w: 10, h: 10 }],
    ['bottom', { x: 10, y: 42, w: 10, h: 10 }],
  ])('rejects a box past the %s edge by more than the tolerance', (_edge, inner) => {
    expect(insideBox(inner, OUTER, TOLERANCE)).toBe(false);
  });

  it.each([
    ['left', { x: -1, y: 10, w: 10, h: 10 }],
    ['top', { x: 10, y: -1, w: 10, h: 10 }],
    ['right', { x: 91, y: 10, w: 10, h: 10 }],
    ['bottom', { x: 10, y: 41, w: 10, h: 10 }],
  ])('forgives a box past the %s edge by exactly the tolerance', (_edge, inner) => {
    expect(insideBox(inner, OUTER, TOLERANCE)).toBe(true);
  });
});

describe('insideViewport', () => {
  const VIEWPORT = { width: 390, height: 844 };

  it('accepts a box flush with the viewport', () => {
    expect(insideViewport({ x: 0, y: 0, w: 390, h: 844 }, VIEWPORT, 0)).toBe(true);
  });

  it.each([
    ['left', { x: -2, y: 0, w: 10, h: 10 }],
    ['right', { x: 382, y: 0, w: 10, h: 10 }],
    ['bottom', { x: 0, y: 836, w: 10, h: 10 }],
    ['top', { x: 0, y: -2, w: 10, h: 10 }],
  ])('rejects text clipped at the %s edge', (_edge, box) => {
    expect(insideViewport(box, VIEWPORT, TOLERANCE)).toBe(false);
  });
});

describe('withoutCovers', () => {
  const LENS: Box = { x: 50, y: 50, w: 100, h: 30 };
  const under: Box = { x: 60, y: 60, w: 20, h: 10 };
  const beside: Box = { x: 200, y: 60, w: 20, h: 10 };
  const touching: Box = { x: 150, y: 60, w: 20, h: 10 };

  it('keeps every box when nothing covers the Map', () => {
    expect(withoutCovers([under, beside], [])).toEqual([under, beside]);
  });

  it('drops only the boxes an intended cover lies over', () => {
    expect(withoutCovers([under, beside, touching], [LENS])).toEqual([beside, touching]);
  });
});

describe('within', () => {
  const SUBTREE = { box: { x: 0, y: 0, w: 1, h: 1 }, index: 10, span: 3 };
  const record = (index: number): TextRecord => ({
    text: 't',
    fontSize: 12,
    fontFamily: 'serif',
    fontWeight: '400',
    color: 'black',
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    visible: { x: 0, y: 0, w: 1, h: 1 },
    cover: 'none',
    testId: null,
    parent: null,
    index,
    span: 0,
  });

  it('counts the subtree root itself as outside and its last descendant as inside', () => {
    expect(within(record(10), SUBTREE)).toBe(false);
    expect(within(record(11), SUBTREE)).toBe(true);
    expect(within(record(13), SUBTREE)).toBe(true);
    expect(within(record(14), SUBTREE)).toBe(false);
  });
});
