/* eslint-env jest */
/* global describe, it, expect */

import {
  clampLensCenter,
  contentOffset,
  DRAG_TAP_SLOP,
  glideDurationMs,
  inertialStageTarget,
  lensCaption,
  lensCenterForStage,
  lensFrame,
  MAGNIFICATION,
  magnifierTransform,
  nearestStage,
} from '../magnifierGeometry';
import { STAGE_DISPLAY, TITLE_BY_STAGE } from '../mapLayout';
import { STAGE_COUNT } from '../stageData';
import { centerColumnBounds, stageWavePoint } from '../waveGeometry';

const GRID_WIDTH = 300;
const GRID_HEIGHT = 600;

describe('lensFrame', () => {
  it('spans slightly beyond the center column but never past the grid', () => {
    const { left, right } = centerColumnBounds(GRID_WIDTH);
    const frame = lensFrame(GRID_WIDTH, GRID_HEIGHT);
    expect(frame.width).toBeGreaterThan(right - left);
    expect(frame.width).toBeLessThanOrEqual(GRID_WIDTH);
  });

  it('clamps to the pill width on a narrow grid', () => {
    const narrow = lensFrame(50, GRID_HEIGHT);
    expect(narrow.width).toBeLessThanOrEqual(50);
  });

  it('keeps the pill height within its band-derived bounds', () => {
    // 600px / 10 stages = 60px band; 85% of it (51) sits below the 56 floor.
    const frame = lensFrame(GRID_WIDTH, GRID_HEIGHT);
    expect(frame.height).toBe(56);
    // A very tall grid caps at the max height instead of growing panel-sized.
    const tall = lensFrame(GRID_WIDTH, 4000);
    expect(tall.height).toBe(84);
    // A tiny grid can never produce a lens taller than the grid itself.
    const tiny = lensFrame(GRID_WIDTH, 40);
    expect(tiny.height).toBeLessThanOrEqual(40);
  });

  it('reports a full pill radius (half the height)', () => {
    const frame = lensFrame(GRID_WIDTH, GRID_HEIGHT);
    expect(frame.radius).toBe(frame.height / 2);
  });
});

describe('lensCenterForStage', () => {
  it('rests on the center-column midline horizontally', () => {
    const { left, right } = centerColumnBounds(GRID_WIDTH);
    const center = lensCenterForStage(3, GRID_WIDTH, GRID_HEIGHT);
    expect(center.x).toBeCloseTo((left + right) / 2);
  });

  it('rests at the stage wave anchor vertically (nominal bands by default)', () => {
    const center = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
    expect(center.y).toBeCloseTo(stageWavePoint(1).y * GRID_HEIGHT);
  });

  it('follows measured anchors when provided', () => {
    const anchors = { 4: 0.42 };
    const center = lensCenterForStage(4, GRID_WIDTH, GRID_HEIGHT, anchors);
    expect(center.y).toBeCloseTo(0.42 * GRID_HEIGHT);
  });
});

describe('clampLensCenter', () => {
  const frame = lensFrame(GRID_WIDTH, GRID_HEIGHT);

  it('passes interior points through unchanged', () => {
    const inside = { x: GRID_WIDTH / 2, y: GRID_HEIGHT / 2 };
    expect(clampLensCenter(inside, frame, GRID_WIDTH, GRID_HEIGHT)).toEqual(inside);
  });

  it('keeps the whole pill inside every grid edge', () => {
    const clamped = clampLensCenter({ x: -50, y: -50 }, frame, GRID_WIDTH, GRID_HEIGHT);
    expect(clamped.x).toBe(frame.width / 2);
    expect(clamped.y).toBe(frame.height / 2);
    const far = clampLensCenter({ x: 9999, y: 9999 }, frame, GRID_WIDTH, GRID_HEIGHT);
    expect(far.x).toBe(GRID_WIDTH - frame.width / 2);
    expect(far.y).toBe(GRID_HEIGHT - frame.height / 2);
  });

  it('degrades safely when the lens is as large as the grid', () => {
    const clamped = clampLensCenter({ x: 0, y: 0 }, frame, frame.width, frame.height);
    expect(clamped.x).toBe(frame.width / 2);
    expect(clamped.y).toBe(frame.height / 2);
  });
});

describe('nearestStage', () => {
  it('snaps exactly onto a stage anchor', () => {
    for (const stage of [1, 5, 10]) {
      const y = stageWavePoint(stage).y * GRID_HEIGHT;
      expect(nearestStage(y, GRID_HEIGHT)).toBe(stage);
    }
  });

  it('snaps to the closer of two neighbouring stages', () => {
    const y1 = stageWavePoint(1).y * GRID_HEIGHT;
    const y2 = stageWavePoint(2).y * GRID_HEIGHT;
    const nearerTo2 = y2 + (y1 - y2) * 0.25;
    expect(nearestStage(nearerTo2, GRID_HEIGHT)).toBe(2);
  });

  it('respects measured anchors over nominal bands', () => {
    // Move stage 7's measured center near the bottom; a bottom hover snaps to it.
    const anchors = { 7: 0.97 };
    expect(nearestStage(0.97 * GRID_HEIGHT, GRID_HEIGHT, anchors)).toBe(7);
  });

  it('clamps to the arc extremes above and below the strand', () => {
    expect(nearestStage(-100, GRID_HEIGHT)).toBe(STAGE_COUNT);
    expect(nearestStage(GRID_HEIGHT + 100, GRID_HEIGHT)).toBe(1);
  });
});

describe('inertialStageTarget', () => {
  it('projects a fast upward swipe several stages along the vertical track', () => {
    const stage3Y = stageWavePoint(3).y * GRID_HEIGHT;
    expect(inertialStageTarget(stage3Y, -1.4, GRID_HEIGHT)).toBe(6);
  });

  it('keeps slow releases at the nearest stage', () => {
    const stage3Y = stageWavePoint(3).y * GRID_HEIGHT;
    expect(inertialStageTarget(stage3Y, -0.05, GRID_HEIGHT)).toBe(3);
  });

  it('clamps projected momentum to the map ends', () => {
    const stage9Y = stageWavePoint(9).y * GRID_HEIGHT;
    expect(inertialStageTarget(stage9Y, -4, GRID_HEIGHT)).toBe(STAGE_COUNT);
    const stage2Y = stageWavePoint(2).y * GRID_HEIGHT;
    expect(inertialStageTarget(stage2Y, 4, GRID_HEIGHT)).toBe(1);
  });
});

describe('magnifierTransform + contentOffset', () => {
  it('maps the lens-center grid point onto the pill center for any center', () => {
    const frame = lensFrame(GRID_WIDTH, GRID_HEIGHT);
    const transform = magnifierTransform(frame, GRID_WIDTH, GRID_HEIGHT);
    const centers = [
      { x: 180, y: 570 },
      { x: 60, y: 30 },
      { x: 240, y: 300 },
    ];
    for (const center of centers) {
      const { tx, ty } = contentOffset(center, transform);
      // RN scales about the content's own midpoint, then translates.
      const contentMidX = GRID_WIDTH / 2;
      const contentMidY = GRID_HEIGHT / 2;
      const renderedX = contentMidX + MAGNIFICATION * (center.x - contentMidX) + tx;
      const renderedY = contentMidY + MAGNIFICATION * (center.y - contentMidY) + ty;
      expect(renderedX).toBeCloseTo(frame.width / 2);
      expect(renderedY).toBeCloseTo(frame.height / 2);
    }
  });

  it('magnifies (scale factor above 1)', () => {
    expect(MAGNIFICATION).toBeGreaterThan(1);
  });
});

describe('glideDurationMs', () => {
  it('never dips below the minimum so short hops still read as motion', () => {
    expect(glideDurationMs(0)).toBe(260);
    expect(glideDurationMs(10)).toBe(260);
  });

  it('scales with distance between the clamps', () => {
    expect(glideDurationMs(400)).toBeCloseTo(440);
    expect(glideDurationMs(300)).toBeLessThan(glideDurationMs(500));
  });

  it('caps long journeys at the maximum', () => {
    expect(glideDurationMs(100000)).toBe(900);
  });
});

describe('lensCaption', () => {
  it('uses the Aspect arrow word for labelled stages', () => {
    const caption = lensCaption(3);
    expect(caption.headline).toBe('Self-Love');
    expect(caption.detail).toBe('Dominator · Power');
  });

  it('falls back to the UNITY / EMPTINESS titles for the top stages', () => {
    expect(lensCaption(9).headline).toBe(TITLE_BY_STAGE[9]);
    expect(lensCaption(10).headline).toBe(TITLE_BY_STAGE[10]);
  });

  it('covers every stage with a non-empty headline and detail', () => {
    for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
      const caption = lensCaption(stage);
      expect(caption.headline.length).toBeGreaterThan(0);
      expect(caption.detail).toContain(STAGE_DISPLAY[stage]?.persona ?? '');
    }
  });

  it('resolves unknown stages to empty strings instead of throwing', () => {
    expect(lensCaption(99)).toEqual({ headline: '', detail: '' });
  });
});

describe('DRAG_TAP_SLOP', () => {
  it('is a small positive px threshold (a tap, not a drag)', () => {
    expect(DRAG_TAP_SLOP).toBeGreaterThan(0);
    expect(DRAG_TAP_SLOP).toBeLessThanOrEqual(12);
  });
});
