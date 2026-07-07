// frontend/features/Map/magnifierGeometry.ts

/**
 * Pure geometry + presentation resolution for the Map's glass magnifier — the
 * draggable "you are here" lens that floats over the center column, magnifies
 * the wave arcs beneath it, and glides between stages. Everything here works in
 * pixel space derived from the measured grid; none of it touches React, so the
 * lens math is testable in isolation from rendering and animation.
 *
 * The lens rides the same measured ``StageAnchors`` the wave overlay threads
 * through, so its per-stage resting points sit exactly on the strand.
 */

import { STAGE_DISPLAY, TITLE_BY_STAGE } from './mapLayout';
import { STAGE_COUNT } from './stageData';
import { centerColumnBounds, stageWavePoint } from './waveGeometry';
import type { StageAnchors } from './waveGeometry';

/**
 * How much larger the map reads through the glass. Chosen so a stage's arc pair
 * fills the pill without the neighbouring stages' strands vanishing entirely.
 */
export const MAGNIFICATION = 1.6;

/**
 * The lens spans slightly beyond the center column so the arcs' pole extremes
 * (which sit at the column edges) stay in view through the glass.
 */
const LENS_WIDTH_SCALE = 1.08;

/** Lens height as a fraction of one nominal stage band (gridHeight / stages). */
const LENS_BAND_FRACTION = 0.85;

/** Smallest pill tall enough for the chip + caption + a 44dp-order tap target. */
const LENS_MIN_HEIGHT = 56;

/** Tallest pill; beyond this the "pill" reads as a panel and hides the map. */
const LENS_MAX_HEIGHT = 84;

/** Finger travel below which a touch release still reads as a tap, in pixels. */
export const DRAG_TAP_SLOP = 6;

/** Shortest glide, so even a one-row hop reads as motion rather than a jump. */
const GLIDE_MIN_MS = 260;

/** Longest glide, so a bottom-to-top journey still settles promptly. */
const GLIDE_MAX_MS = 900;

/** Additional glide time per pixel of travel between resting points. */
const GLIDE_MS_PER_PX = 1.1;

/** Momentum look-ahead window: fast swipes project a few stage bands forward. */
const INERTIA_PROJECTION_MS = 120;

/** Clamp ``value`` into [min, max]; min wins when the range is degenerate. */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** The lens pill's fixed pixel box: width, height, and full pill radius. */
export interface LensFrame {
  width: number;
  height: number;
  radius: number;
}

/** The lens's center point in grid pixel space. */
export interface LensCenter {
  x: number;
  y: number;
}

/** Size the lens pill from the measured grid: column-spanning, band-tall. */
export const lensFrame = (gridWidth: number, gridHeight: number): LensFrame => {
  const { left, right } = centerColumnBounds(gridWidth);
  const width = Math.min(gridWidth, (right - left) * LENS_WIDTH_SCALE);
  const band = gridHeight / STAGE_COUNT;
  const height = Math.min(
    gridHeight,
    clamp(band * LENS_BAND_FRACTION, LENS_MIN_HEIGHT, LENS_MAX_HEIGHT),
  );
  return { width, height, radius: height / 2 };
};

/**
 * The lens's resting center over a stage: the center column's horizontal
 * midline at the stage's measured (or nominal) wave-anchor height — the same
 * vertical truth the wave overlay draws through.
 */
export const lensCenterForStage = (
  stageNumber: number,
  gridWidth: number,
  gridHeight: number,
  anchors: StageAnchors = {},
): LensCenter => {
  const { left, right } = centerColumnBounds(gridWidth);
  return {
    x: (left + right) / 2,
    y: stageWavePoint(stageNumber, anchors).y * gridHeight,
  };
};

/** Keep the whole lens box inside the grid while dragging or gliding. */
export const clampLensCenter = (
  center: LensCenter,
  frame: LensFrame,
  gridWidth: number,
  gridHeight: number,
): LensCenter => ({
  x: clamp(center.x, frame.width / 2, Math.max(frame.width / 2, gridWidth - frame.width / 2)),
  y: clamp(center.y, frame.height / 2, Math.max(frame.height / 2, gridHeight - frame.height / 2)),
});

/**
 * The stage whose wave anchor sits closest to a vertical lens position — the
 * snap target when a drag releases. Vertical distance is the whole story: the
 * stages ladder strictly upward, so x never disambiguates.
 */
export const nearestStage = (
  centerY: number,
  gridHeight: number,
  anchors: StageAnchors = {},
): number => {
  let best = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
    const distance = Math.abs(stageWavePoint(stage, anchors).y * gridHeight - centerY);
    if (distance < bestDistance) {
      best = stage;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * Choose the stage a released swipe should coast toward. ``velocityY`` is in
 * px/ms (positive downward), so projecting the release point forward keeps the
 * lens on its vertical rail while making faster swipes coast across more rows.
 */
export const inertialStageTarget = (
  centerY: number,
  velocityY: number,
  gridHeight: number,
  anchors: StageAnchors = {},
): number => nearestStage(centerY + velocityY * INERTIA_PROJECTION_MS, gridHeight, anchors);

/**
 * Constants of the magnified-content mapping. A full-size copy of the grid
 * artwork is scaled by ``magnification`` about its own center (React Native's
 * fixed transform origin) and then translated; solving "grid point C must land
 * on the lens's own center" for that translation gives, per axis:
 *
 *   t = frame/2 + (magnification - 1) * grid/2 - magnification * C
 *
 * ``kx`` / ``ky`` are the C-independent parts, so an animated lens center only
 * needs a multiply-and-add to keep the magnified world locked under the glass.
 */
export interface MagnifierTransform {
  kx: number;
  ky: number;
  magnification: number;
}

/** Precompute the C-independent parts of the magnified-content mapping. */
export const magnifierTransform = (
  frame: LensFrame,
  gridWidth: number,
  gridHeight: number,
): MagnifierTransform => ({
  kx: frame.width / 2 + ((MAGNIFICATION - 1) * gridWidth) / 2,
  ky: frame.height / 2 + ((MAGNIFICATION - 1) * gridHeight) / 2,
  magnification: MAGNIFICATION,
});

/**
 * Glide duration scaled to travel distance, clamped so short hops still read
 * as motion and long journeys still settle promptly. Pairs with an
 * ease-in-out curve: the lens gathers speed, glides, then slides to a
 * slowing stop.
 */
export const glideDurationMs = (distancePx: number): number =>
  clamp(distancePx * GLIDE_MS_PER_PX, GLIDE_MIN_MS, GLIDE_MAX_MS);

/** The two caption lines the lens shows for the stage under the glass. */
export interface LensCaption {
  /** The Aspect word for the stage (or its UNITY / EMPTINESS title). */
  headline: string;
  /** The stage's persona and mode of knowing, dot-separated. */
  detail: string;
}

/**
 * Resolve the caption for a stage under the glass: its Aspect arrow word (or
 * the UNITY / EMPTINESS title carried by stages 9–10) over its persona and
 * descriptor. Unknown stages resolve to empty strings rather than throwing so
 * a transient out-of-range hover can never take the Map down.
 */
export const lensCaption = (stageNumber: number): LensCaption => {
  const display = STAGE_DISPLAY[stageNumber];
  if (!display) return { headline: '', detail: '' };
  const headline = display.arrowLabel || TITLE_BY_STAGE[display.stageNumber] || '';
  return { headline, detail: `${display.persona} · ${display.descriptor}` };
};
