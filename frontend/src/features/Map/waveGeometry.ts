// frontend/features/Map/waveGeometry.ts

/**
 * Pure geometry for the Map center column's continuous sine-wave (a
 * struck-tuning-fork rising upward). Every helper works in unit space [0,1] or
 * scales that unit space into pixel space; none of them touch React, so the wave
 * math is testable in isolation from rendering.
 *
 * The wave wobbles left for even (Divine-Feminine / WE-returning) stages and
 * right for odd (I-pointing) stages. Its horizontal swing tapers smoothly and
 * monotonically from the widest stage-1 offset down to a tiny non-degenerate
 * apex at stage 10, so the two poles resolve into the whole as the wave rises.
 * Each segment also carries a mirrored far-side path (drawn faded behind the
 * near side) so the whole reads as a three-dimensional coil rather than a flat
 * wobble.
 */

import { STAGE_DISPLAY } from './mapLayout';
import { STAGE_COUNT, isLeftReturning } from './stageData';

/** Horizontal midline of the column in unit space; both poles swing around it. */
const CENTER_X = 0.5;

/**
 * Vertical offset that centers each stage inside its own [0,1] band, so stage 1
 * lands near the bottom (y ~ 0.95) and stage 10 near the top (y ~ 0.05).
 */
const Y_BAND_MIDPOINT = 0.5;

/**
 * Widest horizontal swing from center, at stage 1. Kept below 0.5 so a pole at
 * full amplitude (x = CENTER_X +/- WAVE_AMPLITUDE) stays comfortably inside the
 * unit column with margin for the arrowhead.
 */
const WAVE_AMPLITUDE = 0.32;

/**
 * Converged swing at the stage-10 apex. A tiny non-zero offset keeps the path
 * from degenerating to a vertical stub while reading as fully resolved; it is
 * the lower bound of the smooth taper that starts from WAVE_AMPLITUDE.
 */
const APEX_AMPLITUDE = 0.02;

/** Pole encoding: even stages return left, odd stages point right, apex neutral. */
const POLE_LEFT = -1;
const POLE_RIGHT = 1;
const POLE_NEUTRAL = 0;

/** Half-width of the arrowhead triangle base, in pixels. */
const ARROWHEAD_HALF_WIDTH = 6;
/** Distance from the arrowhead base up to its apex, in pixels. */
const ARROWHEAD_HEIGHT = 10;

/** Decimal places kept in emitted SVG coordinates (matches TierStar). */
const COORD_PRECISION = 3;

/** A stage's number paired with its exact textColor, sorted ascending. */
interface StageColor {
  stageNumber: number;
  textColor: string;
}

/**
 * Every stage's number + textColor, ascending. Derived from ``Object.entries``
 * so the textColor values are non-optional (unlike numeric ``Record`` indexing
 * under ``noUncheckedIndexedAccess``), giving callers exact colors with no
 * never-taken fallback branch.
 */
const STAGE_COLORS: readonly StageColor[] = Object.entries(STAGE_DISPLAY)
  .map(([stageNumber, display]) => ({
    stageNumber: Number(stageNumber),
    textColor: display.textColor,
  }))
  .sort((a, b) => a.stageNumber - b.stageNumber);

/** A single stage's anchor point on the wave, plus which pole it swings to. */
export interface WavePoint {
  /** Horizontal position in unit space [0,1]. */
  x: number;
  /** Vertical position in unit space [0,1]; smaller means higher up. */
  y: number;
  /** -1 left pole (even), +1 right pole (odd), 0 at the converged apex. */
  pole: -1 | 0 | 1;
}

/**
 * Horizontal swing from center for a stage, in unit space. Interpolates
 * linearly from WAVE_AMPLITUDE at stage 1 down to APEX_AMPLITUDE at stage
 * STAGE_COUNT, so the offset shrinks strictly and smoothly as the wave rises.
 */
const amplitudeFor = (stageNumber: number): number =>
  APEX_AMPLITUDE +
  ((WAVE_AMPLITUDE - APEX_AMPLITUDE) * (STAGE_COUNT - stageNumber)) / (STAGE_COUNT - 1);

/** The pole a stage swings toward: left for even, right for odd, neutral at apex. */
const poleFor = (stageNumber: number): -1 | 0 | 1 => {
  if (stageNumber === STAGE_COUNT) return POLE_NEUTRAL;
  return isLeftReturning(stageNumber) ? POLE_LEFT : POLE_RIGHT;
};

/**
 * Anchor point for a stage on the rising wave, in unit space [0,1]. y strictly
 * decreases as stageNumber climbs (the wave rises); x swings around center by
 * the stage's amplitude toward its pole, tapering smoothly toward center at the
 * top.
 *
 * The apex (stage 10) reports a neutral pole but its x still uses the left/right
 * rule, so it lands a hair off dead-center (by APEX_AMPLITUDE) rather than
 * degenerating into a vertical stub. This apparent mismatch is deliberate.
 */
export const stageWavePoint = (stageNumber: number): WavePoint => {
  const y = (STAGE_COUNT - stageNumber + Y_BAND_MIDPOINT) / STAGE_COUNT;
  const direction = isLeftReturning(stageNumber) ? POLE_LEFT : POLE_RIGHT;
  const x = CENTER_X + amplitudeFor(stageNumber) * direction;
  return { x, y, pole: poleFor(stageNumber) };
};

/** A rendered wave segment: its near and far SVG paths, color, and lower stage. */
export interface WaveSegment {
  /** SVG path data in pixel space connecting the two stage points. */
  d: string;
  /**
   * The near-side bezier mirrored across the column center, drawn faded behind
   * ``d`` to read as a coil's far side.
   */
  farD: string;
  /** Stroke color, taken from the lower stage's textColor. */
  color: string;
  /** The lower of the two stage numbers this segment connects (1..9). */
  stageNumber: number;
}

/** Round a unit coordinate into a pixel coordinate string at fixed precision. */
const toPixel = (unit: number, extent: number): string => (unit * extent).toFixed(COORD_PRECISION);

/** Reflect a unit x across the column center: same distance on the far side. */
const mirrorAcrossCenter = (unitX: number): number => CENTER_X + (CENTER_X - unitX);

/**
 * A smooth cubic Bezier between two points given by their unit x's and y's. The
 * control points sit at the vertical midpoint of the pair, each anchored to its
 * own x, giving the center column its continuous sine wobble rather than
 * straight zig-zags. Shared by the near and far paths so the string assembly
 * lives in exactly one place.
 */
const bezierPath = (
  lowerX: number,
  upperX: number,
  lowerY: number,
  upperY: number,
  width: number,
  height: number,
): string => {
  const midY = (lowerY + upperY) / 2;
  const x1 = toPixel(lowerX, width);
  const y1 = toPixel(lowerY, height);
  const x2 = toPixel(upperX, width);
  const y2 = toPixel(upperY, height);
  const midYPixel = toPixel(midY, height);
  return `M ${x1} ${y1} C ${x1} ${midYPixel} ${x2} ${midYPixel} ${x2} ${y2}`;
};

/** Near-side and mirrored far-side bezier paths for a stage pair, in pixels. */
const segmentPaths = (
  lower: WavePoint,
  upper: WavePoint,
  width: number,
  height: number,
): { d: string; farD: string } => ({
  d: bezierPath(lower.x, upper.x, lower.y, upper.y, width, height),
  farD: bezierPath(
    mirrorAcrossCenter(lower.x),
    mirrorAcrossCenter(upper.x),
    lower.y,
    upper.y,
    width,
    height,
  ),
});

/**
 * The full wave as STAGE_COUNT-1 (9) segments in pixel space. Segment i connects
 * stage i to stage i+1 and carries the lower stage's number and textColor.
 * Coordinates scale with width and height, so a larger layout yields a larger
 * wave.
 */
export const waveSegments = (width: number, height: number): readonly WaveSegment[] => {
  const segments: WaveSegment[] = [];
  STAGE_COLORS.reduce<StageColor | null>((previous, current) => {
    if (previous !== null) {
      const lower = stageWavePoint(previous.stageNumber);
      const upper = stageWavePoint(current.stageNumber);
      const { d, farD } = segmentPaths(lower, upper, width, height);
      segments.push({
        d,
        farD,
        color: previous.textColor,
        stageNumber: previous.stageNumber,
      });
    }
    return current;
  }, null);
  return segments;
};

/** An SVG polygon for a single stage's upward-pointing arrowhead. */
export interface Arrowhead {
  /** Space-separated "x,y" pixel coordinates for the triangle's three vertices. */
  points: string;
}

/**
 * An upward-pointing triangle centered on a stage's wave point, in pixel space.
 * The apex sits ARROWHEAD_HEIGHT above the base (numerically smaller y) so the
 * arrow leads toward the higher stages at the top of the wave.
 */
export const arrowheadAt = (stageNumber: number, width: number, height: number): Arrowhead => {
  const point = stageWavePoint(stageNumber);
  const cx = point.x * width;
  const baseY = point.y * height;
  const apexY = baseY - ARROWHEAD_HEIGHT;
  const leftX = cx - ARROWHEAD_HALF_WIDTH;
  const rightX = cx + ARROWHEAD_HALF_WIDTH;
  const fmt = (value: number): string => value.toFixed(COORD_PRECISION);
  const points = [
    `${fmt(cx)},${fmt(apexY)}`,
    `${fmt(leftX)},${fmt(baseY)}`,
    `${fmt(rightX)},${fmt(baseY)}`,
  ].join(' ');
  return { points };
};

/** One stage's arrowhead polygon plus its stage number and fill color. */
export interface WaveArrowhead {
  /** Space-separated "x,y" pixel coordinates for the triangle's three vertices. */
  points: string;
  /** Fill color, the stage's exact textColor. */
  color: string;
  /** The stage this arrowhead marks (1..STAGE_COUNT). */
  stageNumber: number;
}

/**
 * Every stage's upward-pointing arrowhead in pixel space, each carrying the
 * stage's exact textColor. Built from ``STAGE_COLORS`` so the colors are total
 * (no optional-index fallback).
 */
export const waveArrowheads = (width: number, height: number): readonly WaveArrowhead[] =>
  STAGE_COLORS.map(({ stageNumber, textColor }) => ({
    points: arrowheadAt(stageNumber, width, height).points,
    color: textColor,
    stageNumber,
  }));
