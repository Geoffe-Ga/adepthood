import type { MutableRefObject } from 'react';
import { PanResponder } from 'react-native';
import type { PanResponderInstance } from 'react-native';

import type { TierType } from './goalMarker';
import { clampPercentage } from './HabitUtils';
import type { StarFillControls } from './hooks/useStarFill';
import { createMarkerGesture } from './markerGesture';

/**
 * Drag geometry for the two editable tier markers on the goal bar.
 *
 * The modal's pan responders are created once — a gesture has to survive the
 * re-renders it causes — so the percent a drop lands on cannot be read back
 * out of React state at release time. Issue #2884 shipped exactly that: the
 * responder closed over the first-render `useState(0)` markers and confirmed
 * 0 for every drop. Here the position is derived from the gesture's own
 * anchor and dx, so the released value never travels through the render
 * cycle at all.
 */

/** The two tiers whose markers the user can drag; `stretch` is fixed at 100%. */
export type DraggableTier = 'low' | 'clear';

/**
 * Minimum separation, in bar percentage points, kept between the low and
 * clear markers so a drag can never reorder the tiers or hide one behind the
 * other.
 */
export const MARKER_MIN_GAP_PCT = 5;

/** Where a gesture started: the bar it runs on, its own percent, its neighbour's. */
export interface MarkerDragAnchor {
  /** Measured width of the goal bar in pixels; 0 until `onLayout` has fired. */
  barWidthPx: number;
  /** The dragged marker's percent at the moment the finger went down. */
  startPercent: number;
  /** The other draggable marker's percent, which bounds this drag. */
  neighbourPercent: number;
}

/** A single marker's drag, from finger-down to the percent it settles on. */
export interface MarkerDragController {
  /** Re-anchor for a new gesture; the marker settles on its own start percent. */
  start: (_anchor: MarkerDragAnchor) => void;
  /** Apply a pan dx and return the marker's new percent. */
  moveTo: (_dx: number) => number;
  /** The percent the marker is on right now — the value a release confirms. */
  settled: () => number;
}

/** The travel a tier may occupy: the bar, minus the gap its neighbour reserves. */
const boundsFor = (tier: DraggableTier, anchor: MarkerDragAnchor): { min: number; max: number } =>
  tier === 'low'
    ? { min: 0, max: clampPercentage(anchor.neighbourPercent - MARKER_MIN_GAP_PCT) }
    : { min: clampPercentage(anchor.neighbourPercent + MARKER_MIN_GAP_PCT), max: 100 };

/**
 * Clamp a raw percent into the tier's travel. Both window edges are
 * themselves bar-clamped, so `min <= max` holds for every neighbour position
 * and the result is provably within [0, 100] — unlike a bare
 * `Math.min(pct, neighbour - gap)`, which goes negative whenever the
 * neighbour sits inside the gap.
 */
const clampToWindow = (pct: number, tier: DraggableTier, anchor: MarkerDragAnchor): number => {
  const { min, max } = boundsFor(tier, anchor);
  return Math.min(Math.max(clampPercentage(pct), min), max);
};

/**
 * Translate a pan dx into a bar percent. A bar that has not laid out yet has
 * width 0, which would make the division NaN (dx 0) or ±Infinity (dx ≠ 0),
 * so the drag is inert until a real width arrives.
 */
const percentForDx = (anchor: MarkerDragAnchor, dx: number): number =>
  anchor.barWidthPx > 0
    ? anchor.startPercent + (dx / anchor.barWidthPx) * 100
    : anchor.startPercent;

/**
 * Create the drag controller for one marker. `start` deliberately does NOT
 * apply the neighbour window: a tap, or a nudge that returns to where it
 * began, must confirm the marker's actual position rather than be rewritten
 * by a gap correction the user never asked for.
 */
export const createMarkerDragController = (tier: DraggableTier): MarkerDragController => {
  let anchor: MarkerDragAnchor = { barWidthPx: 0, startPercent: 0, neighbourPercent: 0 };
  let current = 0;

  return {
    start: (next: MarkerDragAnchor): void => {
      anchor = next;
      current = clampPercentage(next.startPercent);
    },
    moveTo: (dx: number): number => {
      current = clampToWindow(percentForDx(anchor, dx), tier, anchor);
      return current;
    },
    settled: (): number => current,
  };
};

/**
 * Everything a marker's pan responder needs from the render that is current
 * when the finger touches down.
 *
 * The responders are created once — a gesture has to survive the re-renders
 * it causes — so anything they close over is frozen at first-render values.
 * That is how #2884 shipped. A responder closes over ONLY this ref. Reach new
 * render data by adding a field here; never by capturing a value.
 */
export interface MarkerDragPort {
  /** Measured goal-bar width, written by the bar's `onLayout`. */
  barWidth: MutableRefObject<number>;
  /** The star-fill animation a held press drives, itself behind a ref. */
  starFill: MutableRefObject<StarFillControls>;
  /** Where both draggable markers currently sit on the bar. */
  percent: Record<DraggableTier, number>;
  /** Where both draggable markers belong per the habit's saved goals. */
  canonical: Record<DraggableTier, number>;
  /** Move a marker to a bar percent. */
  setPercent: (_tier: DraggableTier, _percent: number) => void;
  /** Show or hide a tier's tooltip. */
  setTooltip: (_value: TierType | null) => void;
  /** Propose the percent a released marker landed on. */
  confirm: (_tier: DraggableTier, _percent: number) => void;
}

/**
 * Build one marker's pan responder. Call it once per marker per mount: the
 * responder reads live state through `port` on every callback, so it never
 * needs recreating, and recreating it would tear down an in-flight hold.
 *
 * The port is read only from gesture callbacks (grant/move/release), which
 * are user-input driven and therefore always run after a commit has flushed
 * passive effects, so the caller's dependency-free re-pointing effect is
 * enough — the same guarantee the star-fill ref already relies on.
 */
export const createMarkerPanResponder = (
  tier: DraggableTier,
  port: MutableRefObject<MarkerDragPort>,
): PanResponderInstance => {
  const drag = createMarkerDragController(tier);
  const gesture = createMarkerGesture({
    onFillStart: () => port.current.starFill.current.begin(tier),
    onFillRelease: () => port.current.starFill.current.release(),
    onDragMove: (dx) => port.current.setPercent(tier, drag.moveTo(dx)),
    onDragRelease: () => port.current.confirm(tier, drag.settled()),
  });

  return PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      const live = port.current;
      drag.start({
        barWidthPx: live.barWidth.current,
        startPercent: live.percent[tier],
        neighbourPercent: live.percent[tier === 'low' ? 'clear' : 'low'],
      });
      live.setTooltip(tier);
      gesture.grant();
    },
    onPanResponderMove: (_e, g) => gesture.move(g.dx),
    onPanResponderRelease: () => {
      port.current.setTooltip(null);
      gesture.release();
    },
    onPanResponderTerminate: () => {
      // A stolen gesture never confirms, so put the star back where the saved
      // goals say it belongs rather than leaving it half-dragged.
      const live = port.current;
      live.setTooltip(null);
      live.setPercent(tier, live.canonical[tier]);
      gesture.terminate();
    },
  });
};
