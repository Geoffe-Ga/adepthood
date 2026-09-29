/* eslint-env jest */
/* global describe, it, expect */

import { StyleSheet } from 'react-native';

import { STAGE_ORDER } from '../../../design/tokens';
import {
  focusScrollOffset,
  clampLensCenter,
  DRAG_TAP_SLOP,
  glideDurationMs,
  inertialStageTarget,
  lensCaption,
  lensCenterForStage,
  LENS_BORDER_WIDTH,
  LENS_CAPTION_STACK,
  lensCaptionWidth,
  lensFrame,
  LENS_MAX_HEIGHT,
  LENS_MIN_HEIGHT,
  lensStageIdentity,
  MAGNIFICATION,
  magnifierTransform,
  nearestStage,
} from '../magnifierGeometry';
import styles from '../Map.styles';
import { STAGE_DISPLAY, TITLE_BY_STAGE } from '../mapLayout';
import { STAGE_COUNT } from '../stageData';
import type { StageData } from '../stageData';
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
    // 600px / 10 stages = 60px band; 85% of it (51) sits below the floor.
    const frame = lensFrame(GRID_WIDTH, GRID_HEIGHT);
    expect(frame.height).toBe(LENS_MIN_HEIGHT);
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

/**
 * The serif ramp's own leading (``type(width)`` sets ``round(size * 1.25)``):
 * a lens line set tighter than this would clip, so its size cannot grow
 * without its line height, and so without the stack below.
 */
const LEADING_FLOOR = 1.25;

type LensBox = { fontSize?: number; lineHeight?: number };
type LensSpacing = { borderWidth?: number; paddingVertical?: number; marginBottom?: number };

const flat = <T>(style: unknown): T => StyleSheet.flatten(style as object) as T;

describe('the lens floor holds its caption stack (#2960)', () => {
  const LENS_TEXT = ['youAreHereText', 'magnifierHeadline', 'magnifierDetail'] as const;
  const stackFromStyles = (): number => {
    const chip = flat<LensSpacing>(styles.youAreHere);
    return (
      2 * (chip.paddingVertical as number) +
      (chip.marginBottom as number) +
      LENS_TEXT.reduce((sum, key) => sum + (flat<LensBox>(styles[key]).lineHeight as number), 0)
    );
  };

  it.each(['magnifierHeadline', 'magnifierDetail'] as const)(
    'sets %s on an explicit line height no tighter than the ramp',
    (key) => {
      const { fontSize, lineHeight } = flat<LensBox>(styles[key]);
      expect(lineHeight).toBeGreaterThanOrEqual((fontSize as number) * LEADING_FLOOR);
    },
  );

  it('sets the all-caps chip on a line exactly its size: capitals hang no descenders', () => {
    const { fontSize, lineHeight } = flat<LensBox>(styles.youAreHereText);
    expect(lineHeight).toBe(fontSize);
  });

  it('declares the caption stack the styles actually lay out', () => {
    expect(stackFromStyles()).toBe(LENS_CAPTION_STACK);
    expect(flat<LensSpacing>(styles.magnifier).borderWidth).toBe(LENS_BORDER_WIDTH);
  });

  it('gives the smallest pill room past its stack, so the outer rows clear the rounded ends', () => {
    expect(LENS_MIN_HEIGHT).toBeGreaterThan(LENS_CAPTION_STACK + 2 * LENS_BORDER_WIDTH);
    expect(LENS_MIN_HEIGHT).toBeLessThanOrEqual(LENS_MAX_HEIGHT);
    expect(lensFrame(GRID_WIDTH, GRID_HEIGHT).height).toBe(LENS_MIN_HEIGHT);
  });
});

describe('lensCaptionWidth', () => {
  it('narrows the caption to the glass chord at the outer rows of its stack', () => {
    const frame = lensFrame(GRID_WIDTH, GRID_HEIGHT);
    const width = lensCaptionWidth(frame);
    const radius = (frame.height - 2 * LENS_BORDER_WIDTH) / 2;
    const straightRun = frame.width - frame.height;
    // The caption's outer corners sit exactly on the rounded end's arc.
    expect(((width - straightRun) / 2) ** 2 + (LENS_CAPTION_STACK / 2) ** 2).toBeCloseTo(
      radius ** 2,
    );
    expect(width).toBeGreaterThan(straightRun);
    expect(width).toBeLessThan(frame.width - 2 * LENS_BORDER_WIDTH);
  });

  it('falls back to the straight run when the pill is no taller than its stack', () => {
    const frame = { width: 200, height: LENS_CAPTION_STACK, radius: LENS_CAPTION_STACK / 2 };
    expect(lensCaptionWidth(frame)).toBe(frame.width - frame.height);
  });

  it('never reports a negative width for a pill narrower than it is tall', () => {
    expect(lensCaptionWidth({ width: 10, height: 80, radius: 40 })).toBe(0);
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

describe('magnifierTransform', () => {
  it('maps the lens-center grid point onto the pill center for any center', () => {
    const frame = lensFrame(GRID_WIDTH, GRID_HEIGHT);
    const transform = magnifierTransform(frame, GRID_WIDTH, GRID_HEIGHT);
    const centers = [
      { x: 180, y: 570 },
      { x: 60, y: 30 },
      { x: 240, y: 300 },
    ];
    for (const center of centers) {
      const tx = transform.kx - MAGNIFICATION * center.x;
      const ty = transform.ky - MAGNIFICATION * center.y;
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

const makeStage = (overrides: Partial<StageData> = {}): StageData => ({
  id: 4,
  title: 'Stage 4',
  subtitle: 'Subtitle',
  stageNumber: 4,
  progress: 0,
  color: '#aaa',
  isUnlocked: true,
  category: 'Love',
  aspect: 'Community',
  spiralDynamicsColor: 'Blue',
  growingUpStage: 'Conformity',
  divineGenderPolarity: 'Divine Feminine',
  relationshipToFreeWill: 'Victim',
  freeWillDescription: 'Behaviour is determined by the relationships one is embedded in.',
  overviewUrl: '',
  manifestations: [],
  ...overrides,
});

describe('lensCaption', () => {
  it('surfaces the stage title and subtitle from backend data', () => {
    const caption = lensCaption(makeStage());
    expect(caption.title).toBe('Stage 4');
    expect(caption.subtitle).toBe('Subtitle');
  });

  it('carries a distinct subtitle through unchanged', () => {
    const caption = lensCaption(makeStage({ subtitle: 'Active Yes-And-Ness' }));
    expect(caption.subtitle).toBe('Active Yes-And-Ness');
  });

  it('resolves missing stage data to empty strings instead of throwing', () => {
    expect(lensCaption(undefined)).toEqual({ title: '', subtitle: '' });
  });

  it('surfaces an empty subtitle without falling over', () => {
    const caption = lensCaption(makeStage({ subtitle: '' }));
    expect(caption.subtitle).toBe('');
    expect(caption.title).toBe('Stage 4');
  });
});

describe('lensStageIdentity', () => {
  it('identifies a stage by its Aspect word, number, colour, and persona', () => {
    const identity = lensStageIdentity(3);
    expect(identity).toContain('Self-Love');
    expect(identity).toContain('3 · RED');
    expect(identity).toContain(STAGE_DISPLAY[3]?.persona ?? '');
  });

  it('falls back to the UNITY / EMPTINESS titles for the top stages', () => {
    expect(lensStageIdentity(9)).toContain(TITLE_BY_STAGE[9]);
    expect(lensStageIdentity(10)).toContain(TITLE_BY_STAGE[10]);
  });

  it('names every stage with its number and uppercased spiral colour', () => {
    for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
      const identity = lensStageIdentity(stage);
      expect(identity).toContain(`${stage} · ${(STAGE_ORDER[stage - 1] ?? '').toUpperCase()}`);
      expect(identity).toContain(STAGE_DISPLAY[stage]?.persona ?? '');
    }
  });

  it('resolves an unknown stage to an empty identity instead of throwing', () => {
    expect(lensStageIdentity(99)).toBe('');
  });
});

describe('DRAG_TAP_SLOP', () => {
  it('is a small positive px threshold (a tap, not a drag)', () => {
    expect(DRAG_TAP_SLOP).toBeGreaterThan(0);
    expect(DRAG_TAP_SLOP).toBeLessThanOrEqual(12);
  });
});

// #2657: once the Map scrolls, a glide to a stage below the fold would land
// where nobody can see it, so the scroller follows the focused stage.
describe('focusScrollOffset', () => {
  const BASE = { halfExtent: 20, scrollY: 0, viewportHeight: 200, contentHeight: 650 };

  it('asks for no scroll when the content fits its viewport', () => {
    expect(focusScrollOffset({ ...BASE, anchorY: 500, contentHeight: 200 })).toBeNull();
    expect(focusScrollOffset({ ...BASE, anchorY: 500, contentHeight: 199 })).toBeNull();
  });

  it('leaves the scroller alone while the whole lens is already in the window', () => {
    expect(focusScrollOffset({ ...BASE, anchorY: 20 })).toBeNull();
    expect(focusScrollOffset({ ...BASE, anchorY: 180 })).toBeNull();
    expect(focusScrollOffset({ ...BASE, anchorY: 320, scrollY: 300 })).toBeNull();
  });

  it('moves as soon as any of the lens leaves the window, on either side', () => {
    expect(focusScrollOffset({ ...BASE, anchorY: 181 })).toBe(81);
    expect(focusScrollOffset({ ...BASE, anchorY: 319, scrollY: 300 })).toBe(219);
  });

  it('centres the focused anchor in the viewport', () => {
    expect(focusScrollOffset({ ...BASE, anchorY: 300 })).toBe(300 - BASE.viewportHeight / 2);
  });

  it('never scrolls above the top or past the end of the content', () => {
    expect(focusScrollOffset({ ...BASE, anchorY: 40, scrollY: 400 })).toBe(0);
    expect(focusScrollOffset({ ...BASE, anchorY: 640 })).toBe(
      BASE.contentHeight - BASE.viewportHeight,
    );
  });
});
