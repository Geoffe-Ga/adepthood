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

import { editorialType, spacing, STAGE_ORDER } from '../../design/tokens';

import { STAGE_COUNT } from './stageData';
import type { StageData } from './stageData';
import { stageHeadline, stagePersona } from './stageVocabulary';
import type { VocabularySource } from './stageVocabulary';
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

/** The glass rim's stroke width, drawn inside the pill's box. */
export const LENS_BORDER_WIDTH = 2;

/**
 * Line height of the "YOU ARE HERE" chip: exactly its caption size, because
 * an all-capitals line hangs no descenders to leave room for.
 */
export const LENS_CHIP_LINE_HEIGHT = editorialType.caption.fontSize;

/** Line height of the stage subtitle: the caption step. */
export const LENS_CAPTION_LINE_HEIGHT = editorialType.caption.lineHeight;

/** Line height of the stage title: the interactive-floor (action) step. */
export const LENS_HEADLINE_LINE_HEIGHT = editorialType.action.lineHeight;

/** The chip's vertical padding, and the gap between the chip and the title. */
export const LENS_CHIP_INSET = spacing(0.25);

/** The caption's full height: the padded chip and its gap, the title, the subtitle. */
export const LENS_CAPTION_STACK =
  2 * LENS_CHIP_INSET +
  LENS_CHIP_LINE_HEIGHT +
  LENS_CHIP_INSET +
  LENS_HEADLINE_LINE_HEIGHT +
  LENS_CAPTION_LINE_HEIGHT;

/**
 * Glass kept free above and below the caption, so its outer rows sit where the
 * pill's rounded ends have already opened out rather than at their tips.
 */
const LENS_END_CLEARANCE = spacing(0.5);

/**
 * Smallest pill tall enough for its caption (#2960): the stack, the clearance
 * either side of it and the rim. Derived rather than guessed, so a caption that
 * grows grows the pill with it; it is also above a 44dp-order tap target.
 */
export const LENS_MIN_HEIGHT = LENS_CAPTION_STACK + 2 * (LENS_END_CLEARANCE + LENS_BORDER_WIDTH);

/** Tallest pill; beyond this the "pill" reads as a panel and hides the map. */
export const LENS_MAX_HEIGHT = 84;

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
 * How wide the caption may run: the chord of the glass at the caption's outer
 * rows (half the stack above and below the midline). A pill's ends are
 * half-discs, so a caption as wide as the pill would poke its top and bottom
 * corners through the rounded ends; bounding it by this chord keeps every line
 * on the glass, and a line longer than the chord truncates (``numberOfLines``).
 * A pill no taller than its stack leaves only the straight run.
 */
export const lensCaptionWidth = (frame: LensFrame): number => {
  const radius = (frame.height - 2 * LENS_BORDER_WIDTH) / 2;
  const halfRow = Math.min(LENS_CAPTION_STACK / 2, radius);
  const straightRun = frame.width - frame.height;
  return Math.max(0, straightRun + 2 * Math.sqrt(radius ** 2 - halfRow ** 2));
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

/**
 * The lens caption mirrors the stage-detail modal header's two lines — title
 * over subtitle — sourced from backend ``StageData`` (never hardcoded) so
 * ontology corrections flow through automatically; missing data resolves to
 * empty strings rather than throwing.
 */
export interface LensCaption {
  /** The stage's name (e.g. "Survival"). */
  title: string;
  /** The stage's subtitle beneath it (e.g. "Active Yes-And-Ness"). */
  subtitle: string;
  /** What a screen reader hears the lens is over (``lensStageIdentity``); never empty. */
  identity: string;
}

/**
 * Screen-reader identity for a stage: its Aspect word (or the UNITY / EMPTINESS
 * watermark carried by the title stages), stage number + Spiral color, and
 * persona -- all from the served stage (#2666). The visible pill sheds this
 * detail because it duplicates the Map's columns, but a screen-reader user
 * can't cross-reference those columns, so the spoken label keeps it. A stage
 * not yet served still reads as its number and color, never as nothing.
 */
export const lensStageIdentity = (
  stage: VocabularySource | undefined,
  stageNumber: number,
): string => {
  const colorName = (STAGE_ORDER[stageNumber - 1] ?? '').toUpperCase();
  const position = `stage ${stageNumber} · ${colorName}`;
  if (stage === undefined) return position;
  return `${stageHeadline(stage)}, ${position}, ${stagePersona(stage)}`;
};

/**
 * Resolve the lens caption from a stage's backend data: its title over its
 * subtitle, plus the spoken identity. All are sourced from ``StageData`` (never
 * hardcoded) so ontology corrections flow through automatically. Missing data
 * — a cold start, a fetch error, or an out-of-range hover — resolves the two
 * visible lines to empty strings rather than throwing, so a transient gap can
 * never take the Map down.
 */
export const lensCaption = (stage: StageData | undefined, stageNumber: number): LensCaption => ({
  title: stage?.title ?? '',
  subtitle: stage?.subtitle ?? '',
  identity: lensStageIdentity(stage, stageNumber),
});

/** The Map scroller and a focused stage, as ``focusScrollOffset`` reads them. */
export interface FocusScrollInput {
  /** The focused stage's wave anchor, in scroll-content (= grid) pixels. */
  anchorY: number;
  /** How far the lens reaches above and below that anchor. */
  halfExtent: number;
  /** The scroller's current offset. */
  scrollY: number;
  viewportHeight: number;
  contentHeight: number;
}

/**
 * Where the Map's scroller should move so a newly focused stage can be seen
 * (#2657): a glide to a stage below the fold would otherwise land where nobody
 * can see it. Null -- leave the scroller alone -- when the content fits, or when
 * the lens around the anchor is already wholly in the window (a drag settles
 * where the finger left it, which is on screen). Otherwise the anchor is
 * centred, clamped to the content.
 */
export const focusScrollOffset = ({
  anchorY,
  halfExtent,
  scrollY,
  viewportHeight,
  contentHeight,
}: FocusScrollInput): number | null => {
  const maxOffset = contentHeight - viewportHeight;
  if (maxOffset <= 0) return null;
  const inView =
    anchorY - halfExtent >= scrollY && anchorY + halfExtent <= scrollY + viewportHeight;
  if (inView) return null;
  return clamp(anchorY - viewportHeight / 2, 0, maxOffset);
};
