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
 *
 * Each stage's color resolves near the centerline: rather than a stage's hue
 * changing at the outside pole extremes where the anchors sit, every pair's
 * cubic is split at its parametric midpoint (t = 0.5) into a lower and an upper
 * half. That midpoint is where the swing hands off between the pair's two
 * opposite poles, close to the column centerline. Each stage's hue then wraps
 * symmetrically around its own pole extreme, changing over at those seams.
 * Splitting a bezier at a parameter reproduces the identical curve, so only the
 * color phase shifts.
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

/** Which centerline-split piece of a stage pair's cubic a segment carries. */
export type SegmentHalf = 'lower' | 'upper';

/** The lower half runs from the pair's anchor up to the midline seam. */
const HALF_LOWER: SegmentHalf = 'lower';
/** The upper half runs from the midline seam up to the next pair's anchor. */
const HALF_UPPER: SegmentHalf = 'upper';

/** One centerline-split half of a stage pair's cubic: its path, color, band. */
export interface WaveSegment {
  /** SVG path data in pixel space for this half of the pair's cubic. */
  d: string;
  /** Stroke color: the textColor of the stage whose band this half belongs to. */
  color: string;
  /** The pair's lower stage number (1..9); both halves of a pair share it. */
  stageNumber: number;
  /** Discriminates the two centerline-split pieces of the pair's cubic. */
  half: SegmentHalf;
}

/** Round a raw pixel value to a coordinate string at fixed precision. */
const roundCoord = (value: number): string => value.toFixed(COORD_PRECISION);

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

/** A point in pixel space; a cubic's endpoints and controls are all points. */
interface Point {
  x: number;
  y: number;
}

/** A cubic Bezier in pixel space: two endpoints and their two control points. */
interface Cubic {
  start: Point;
  control1: Point;
  control2: Point;
  end: Point;
}

/** The two centerline-split halves of a pair's cubic, still in pixel space. */
interface SplitCubic {
  lower: Cubic;
  upper: Cubic;
}

/** The midpoint of two points; averaging is the de Casteljau step itself. */
const midpoint = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

/**
 * The pair's cubic in raw (unrounded) pixel space. Control points share the
 * pair's vertical midpoint midY, each anchored to its own endpoint x, giving the
 * column its continuous sine wobble rather than straight zig-zags. x is confined
 * to the center-column band via toColumnPixelX (so a unit x of 0.5 lands on the
 * column midline); y spans the full height. Endpoints stay unrounded so the two
 * split halves share an exact seam.
 */
const pairCubic = (lower: WavePoint, upper: WavePoint, width: number, height: number): Cubic => {
  const x1 = toColumnPixelX(lower.x, width);
  const x2 = toColumnPixelX(upper.x, width);
  const y1 = lower.y * height;
  const y2 = upper.y * height;
  const midY = (y1 + y2) / 2;
  return {
    start: { x: x1, y: y1 },
    control1: { x: x1, y: midY },
    control2: { x: x2, y: midY },
    end: { x: x2, y: y2 },
  };
};

/**
 * Split a cubic at its parameter midpoint (t = 0.5) via de Casteljau, using only
 * midpoint averaging. The seam is the shared point where the lower half ends and
 * the upper half begins; because the pair's controls sit at midY, the seam lands
 * at the pair's horizontal midpoint (x1 + x2) / 2, close to the column
 * centerline. The two halves together retrace the original curve byte-for-byte.
 */
const splitCubicAtMidpoint = (cubic: Cubic): SplitCubic => {
  const lowerControl1 = midpoint(cubic.start, cubic.control1);
  const mid = midpoint(cubic.control1, cubic.control2);
  const upperControl2 = midpoint(cubic.control2, cubic.end);
  const lowerControl2 = midpoint(lowerControl1, mid);
  const upperControl1 = midpoint(mid, upperControl2);
  const seam = midpoint(lowerControl2, upperControl1);
  return {
    lower: { start: cubic.start, control1: lowerControl1, control2: lowerControl2, end: seam },
    upper: { start: seam, control1: upperControl1, control2: upperControl2, end: cubic.end },
  };
};

/** Format a pixel-space cubic as an "M x y C cx1 cy1 cx2 cy2 x y" path string. */
const cubicPath = ({ start, control1, control2, end }: Cubic): string =>
  `M ${roundCoord(start.x)} ${roundCoord(start.y)} ` +
  `C ${roundCoord(control1.x)} ${roundCoord(control1.y)} ` +
  `${roundCoord(control2.x)} ${roundCoord(control2.y)} ` +
  `${roundCoord(end.x)} ${roundCoord(end.y)}`;

/**
 * The full wave as 2*(STAGE_COUNT-1) = 18 centerline-split halves in pixel space.
 * Each stage pair's cubic is split at its midline crossing into a lower and an
 * upper half: the lower keeps the pair's own stage color and the upper takes the
 * next stage's, so each stage's hue wraps symmetrically around its pole extreme
 * and changes over at the midline seams. y scales with height and x with width
 * within the center-column band, so a larger layout yields a larger wave that
 * still stays inside its lane.
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
      const halves = splitCubicAtMidpoint(pairCubic(lower, upper, width, height));
      segments.push(
        {
          d: cubicPath(halves.lower),
          color: previous.textColor,
          stageNumber: previous.stageNumber,
          half: HALF_LOWER,
        },
        {
          d: cubicPath(halves.upper),
          color: current.textColor,
          stageNumber: previous.stageNumber,
          half: HALF_UPPER,
        },
      );
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
