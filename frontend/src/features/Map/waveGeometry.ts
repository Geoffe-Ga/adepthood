// frontend/features/Map/waveGeometry.ts

/**
 * Pure geometry for the Map center column's continuous sine-wave (a
 * struck-tuning-fork rising upward). Every helper works in unit space [0,1] or
 * scales that unit space into pixel space; none of them touch React, so the wave
 * math is testable in isolation from rendering. Horizontal unit space maps only
 * across the center column's grid band, not the full grid width, so the wave
 * stays inside its lane even though the SVG spans the whole screen.
 *
 * The wave wobbles left for even (Divine-Feminine / WE-returning) stages and
 * right for odd (I-pointing) stages. Its horizontal swing tapers smoothly and
 * monotonically from the widest stage-1 offset down to a tiny non-degenerate
 * apex at stage 10, so the two poles resolve into the whole as the wave rises.
 */

import { GRID_COLUMN_FLEX, MAP_ROWS, STAGE_DISPLAY } from './mapLayout';
import type { MapRow } from './mapLayout';
import { STAGE_COUNT, isLeftReturning } from './stageData';

/** Combined flex weight of all three row cells; the denominator for band fractions. */
const TOTAL_COLUMN_FLEX = GRID_COLUMN_FLEX.left + GRID_COLUMN_FLEX.center + GRID_COLUMN_FLEX.right;
/** Grid fraction where the center column begins (left flex over total flex). */
const CENTER_COLUMN_START_FRACTION = GRID_COLUMN_FLEX.left / TOTAL_COLUMN_FLEX;
/** Grid fraction the center column spans (center flex over total flex). */
const CENTER_COLUMN_WIDTH_FRACTION = GRID_COLUMN_FLEX.center / TOTAL_COLUMN_FLEX;

/** Horizontal midline of the column in unit space; both poles swing around it. */
const CENTER_X = 0.5;

/**
 * Vertical offset that centers each stage inside its own [0,1] band, so stage 1
 * lands near the bottom (y ~ 0.95) and stage 10 near the top (y ~ 0.05).
 */
const Y_BAND_MIDPOINT = 0.5;

/**
 * Widest horizontal swing from center, at stage 1, as a fraction of the column
 * half-lane. Kept below 0.5 so a pole at full amplitude (x = CENTER_X +/-
 * WAVE_AMPLITUDE) stays comfortably inside the center column with margin for the
 * arrowhead. It is the upper bound of the smooth taper down to APEX_AMPLITUDE.
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
/** Half the arrowhead height; the triangle straddles its anchor by this much. */
const ARROWHEAD_HALF_HEIGHT = ARROWHEAD_HEIGHT / 2;

/** Total row flex across the map: one unit per stage a row contains. */
const TOTAL_ROW_FLEX = MAP_ROWS.reduce((sum, row) => sum + row.stageNumbers.length, 0);

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
 * Measured vertical centers keyed by stage number, in unit space [0,1]. May be
 * partial or empty; any missing stage falls back to its nominal band center.
 */
export type StageAnchors = Readonly<Record<number, number>>;

/** Unit-y center of stageNumber inside its row band, or undefined if absent. */
const rowAnchorY = (row: MapRow, stageNumber: number, bandTop: number): number | undefined => {
  const index = row.stageNumbers.indexOf(stageNumber);
  if (index < 0) return undefined;
  // Every stage owns an equal 1/TOTAL_ROW_FLEX sub-band inside its paired row.
  const subBand = 1 / TOTAL_ROW_FLEX;
  return bandTop + (index + Y_BAND_MIDPOINT) * subBand;
};

/**
 * Fallback unit-y center for a stage, derived by walking MAP_ROWS top-to-bottom
 * with each row weighted by how many stages it holds. This reproduces the legacy
 * uniform-band formula ``(STAGE_COUNT - stageNumber + 0.5) / STAGE_COUNT`` while
 * staying honest to the real row structure. Unknown stages get a safe midpoint.
 */
export const nominalAnchorY = (stageNumber: number): number => {
  let bandTop = 0;
  for (const row of MAP_ROWS) {
    const center = rowAnchorY(row, stageNumber, bandTop);
    if (center !== undefined) return center;
    bandTop += row.stageNumbers.length / TOTAL_ROW_FLEX;
  }
  return Y_BAND_MIDPOINT;
};

/** Measured anchor for a stage when present, else its nominal band center. */
const resolveAnchorY = (stageNumber: number, anchors: StageAnchors): number =>
  anchors[stageNumber] ?? nominalAnchorY(stageNumber);

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
export const stageWavePoint = (stageNumber: number, anchors: StageAnchors = {}): WavePoint => {
  const y = resolveAnchorY(stageNumber, anchors);
  const direction = isLeftReturning(stageNumber) ? POLE_LEFT : POLE_RIGHT;
  const x = CENTER_X + amplitudeFor(stageNumber) * direction;
  return { x, y, pole: poleFor(stageNumber) };
};

/** A rendered wave segment: its SVG path, color, and lower stage. */
export interface WaveSegment {
  /** SVG path data in pixel space connecting the two stage points. */
  d: string;
  /** Stroke color, taken from the lower stage's textColor. */
  color: string;
  /** The lower of the two stage numbers this segment connects (1..9). */
  stageNumber: number;
}

/** Round a raw pixel value to a coordinate string at fixed precision. */
const roundCoord = (value: number): string => value.toFixed(COORD_PRECISION);

/** Round a unit coordinate into a pixel coordinate string at fixed precision. */
const toPixel = (unit: number, extent: number): string => roundCoord(unit * extent);

/** Map a unit x within the center-column band to a pixel x across the grid. */
const toColumnPixelX = (unitX: number, gridWidth: number): number =>
  (CENTER_COLUMN_START_FRACTION + unitX * CENTER_COLUMN_WIDTH_FRACTION) * gridWidth;

/**
 * The center column's left/right pixel edges within a grid of the given width,
 * derived from the shared flex weights.
 */
export const centerColumnBounds = (width: number): { left: number; right: number } => ({
  left: CENTER_COLUMN_START_FRACTION * width,
  right: (CENTER_COLUMN_START_FRACTION + CENTER_COLUMN_WIDTH_FRACTION) * width,
});

/**
 * A smooth cubic Bezier between two points given by their unit x's and y's. The
 * control points sit at the vertical midpoint of the pair, each anchored to its
 * own x, giving the center column its continuous sine wobble rather than
 * straight zig-zags. x is confined to the center-column band via toColumnPixelX
 * (so a unit x of 0.5 lands on the column midline); y spans the full height.
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
  const x1 = roundCoord(toColumnPixelX(lowerX, width));
  const y1 = toPixel(lowerY, height);
  const x2 = roundCoord(toColumnPixelX(upperX, width));
  const y2 = toPixel(upperY, height);
  const midYPixel = toPixel(midY, height);
  return `M ${x1} ${y1} C ${x1} ${midYPixel} ${x2} ${midYPixel} ${x2} ${y2}`;
};

/**
 * The full wave as STAGE_COUNT-1 (9) segments in pixel space. Segment i connects
 * stage i to stage i+1 and carries the lower stage's number and textColor. y
 * scales with height and x with width within the center-column band, so a larger
 * layout yields a larger wave that still stays inside its lane.
 */
export const waveSegments = (
  width: number,
  height: number,
  anchors: StageAnchors = {},
): readonly WaveSegment[] => {
  const segments: WaveSegment[] = [];
  STAGE_COLORS.reduce<StageColor | null>((previous, current) => {
    if (previous !== null) {
      const lower = stageWavePoint(previous.stageNumber, anchors);
      const upper = stageWavePoint(current.stageNumber, anchors);
      segments.push({
        d: bezierPath(lower.x, upper.x, lower.y, upper.y, width, height),
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
 * The triangle straddles the resolved anchor: its apex sits half a height above
 * and its base half a height below, so the arrow is centered on the stage row
 * rather than hanging beneath it. cx is confined to the center-column band.
 */
export const arrowheadAt = (
  stageNumber: number,
  width: number,
  height: number,
  anchors: StageAnchors = {},
): Arrowhead => {
  const point = stageWavePoint(stageNumber, anchors);
  const cx = toColumnPixelX(point.x, width);
  const yPx = point.y * height;
  const apexY = yPx - ARROWHEAD_HALF_HEIGHT;
  const baseY = yPx + ARROWHEAD_HALF_HEIGHT;
  const leftX = cx - ARROWHEAD_HALF_WIDTH;
  const rightX = cx + ARROWHEAD_HALF_WIDTH;
  const points = [
    `${roundCoord(cx)},${roundCoord(apexY)}`,
    `${roundCoord(leftX)},${roundCoord(baseY)}`,
    `${roundCoord(rightX)},${roundCoord(baseY)}`,
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
export const waveArrowheads = (
  width: number,
  height: number,
  anchors: StageAnchors = {},
): readonly WaveArrowhead[] =>
  STAGE_COLORS.map(({ stageNumber, textColor }) => ({
    points: arrowheadAt(stageNumber, width, height, anchors).points,
    color: textColor,
    stageNumber,
  }));
