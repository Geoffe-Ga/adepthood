// frontend/features/Map/waveGeometry.ts

/**
 * Pure geometry for the Map center column's continuous sine-wave (a
 * struck-tuning-fork rising upward). Every helper works in unit space [0,1] or
 * scales that unit space into pixel space; none of them touch React, so the wave
 * math is testable in isolation from rendering.
 *
 * The wave wobbles left for even (Divine-Feminine / WE-returning) stages and
 * right for odd (I-pointing) stages, then converges toward center at the top
 * (stages 9-10) as the two poles resolve into the whole apex.
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
 * Base horizontal swing from center for stages 1-8. Kept below 0.5 so a pole at
 * full amplitude (x = CENTER_X +/- WAVE_AMPLITUDE) stays comfortably inside the
 * unit column with margin for the arrowhead.
 */
const WAVE_AMPLITUDE = 0.32;

/**
 * Stage 9 begins the convergence: its swing is the base amplitude tapered by
 * this ratio, so it sits inside stage 8 but outside the near-center apex.
 */
const TAPER_9 = 0.45;

/**
 * Stage 10 is the converged apex. A tiny non-zero offset keeps the path from
 * degenerating to a vertical stub while staying visually centered; it must be
 * smaller than every stage-9 swing so the wave reads as fully resolved.
 */
const CONVERGENCE_OFFSET = 0.01;

/** Pole encoding: even stages return left, odd stages point right, apex neutral. */
const POLE_LEFT = -1;
const POLE_RIGHT = 1;
const POLE_NEUTRAL = 0;

/** Stages whose swing stays at full base amplitude (before convergence). */
const FULL_AMPLITUDE_MAX_STAGE = 8;
/** The lone taper stage that begins the convergence toward center. */
const TAPER_STAGE = 9;

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

/** Signed horizontal swing from center for a stage, in unit space. */
const amplitudeFor = (stageNumber: number): number => {
  if (stageNumber <= FULL_AMPLITUDE_MAX_STAGE) return WAVE_AMPLITUDE;
  if (stageNumber === TAPER_STAGE) return WAVE_AMPLITUDE * TAPER_9;
  return CONVERGENCE_OFFSET;
};

/** The pole a stage swings toward: left for even, right for odd, neutral at apex. */
const poleFor = (stageNumber: number): -1 | 0 | 1 => {
  if (stageNumber === STAGE_COUNT) return POLE_NEUTRAL;
  return isLeftReturning(stageNumber) ? POLE_LEFT : POLE_RIGHT;
};

/**
 * Anchor point for a stage on the rising wave, in unit space [0,1]. y strictly
 * decreases as stageNumber climbs (the wave rises); x swings around center by
 * the stage's amplitude toward its pole, converging near center at the top.
 *
 * The apex (stage 10) reports a neutral pole but its x still uses the left/right
 * rule, so it lands a hair off dead-center (by CONVERGENCE_OFFSET) rather than
 * degenerating into a vertical stub. This apparent mismatch is deliberate.
 */
export const stageWavePoint = (stageNumber: number): WavePoint => {
  const y = (STAGE_COUNT - stageNumber + Y_BAND_MIDPOINT) / STAGE_COUNT;
  const direction = isLeftReturning(stageNumber) ? POLE_LEFT : POLE_RIGHT;
  const x = CENTER_X + amplitudeFor(stageNumber) * direction;
  return { x, y, pole: poleFor(stageNumber) };
};

/** A rendered wave segment: its SVG path, stroke color, and lower stage number. */
export interface WaveSegment {
  /** SVG path data in pixel space connecting the two stage points. */
  d: string;
  /** Stroke color, taken from the lower stage's textColor. */
  color: string;
  /** The lower of the two stage numbers this segment connects (1..9). */
  stageNumber: number;
}

/** Round a unit coordinate into a pixel coordinate string at fixed precision. */
const toPixel = (unit: number, extent: number): string => (unit * extent).toFixed(COORD_PRECISION);

/**
 * A smooth cubic Bezier between two stage points. The control points sit at the
 * vertical midpoint of the pair, each anchored to its own stage's x, giving the
 * center column its continuous sine wobble rather than straight zig-zags.
 */
const segmentPath = (lower: WavePoint, upper: WavePoint, width: number, height: number): string => {
  const midY = (lower.y + upper.y) / 2;
  const x1 = toPixel(lower.x, width);
  const y1 = toPixel(lower.y, height);
  const x2 = toPixel(upper.x, width);
  const y2 = toPixel(upper.y, height);
  const midYPixel = toPixel(midY, height);
  return `M ${x1} ${y1} C ${x1} ${midYPixel} ${x2} ${midYPixel} ${x2} ${y2}`;
};

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
      segments.push({
        d: segmentPath(lower, upper, width, height),
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
