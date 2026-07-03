import { DRAG_SLOP_PX, STAR_LONG_PRESS_MS } from './starFill';

/**
 * Arbitration between the two gestures a draggable tier marker supports:
 * hold-in-place long-presses become a fill-to-star, while movement past the
 * slop becomes the pre-existing drag-to-edit. The machine is plain JS (no
 * PanResponder types) so the decision logic stays unit-testable with fake
 * timers, and the modal's pan responders reduce to thin adapters.
 */

export interface MarkerGestureCallbacks {
  /** The press survived the long-press threshold without dragging. */
  onFillStart: () => void;
  /** The finger lifted (or the responder terminated) during an active fill. */
  onFillRelease: () => void;
  /** Movement crossed the slop — forward the pan dx to the drag handler. */
  onDragMove: (_dx: number) => void;
  /** A non-fill gesture ended — taps and drags both confirm, as before. */
  onDragRelease: () => void;
}

export interface MarkerGesture {
  grant: () => void;
  move: (_dx: number) => void;
  release: () => void;
  terminate: () => void;
}

type Mode = 'idle' | 'pending' | 'filling' | 'dragging';

/** Create the per-marker gesture arbiter; one instance lives per pan responder. */
export const createMarkerGesture = (callbacks: MarkerGestureCallbacks): MarkerGesture => {
  let mode: Mode = 'idle';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const grant = (): void => {
    mode = 'pending';
    timer = setTimeout(() => {
      timer = null;
      mode = 'filling';
      callbacks.onFillStart();
    }, STAR_LONG_PRESS_MS);
  };

  const move = (dx: number): void => {
    if (mode === 'filling') return; // the fill owns the gesture; no drag
    if (mode === 'pending' && Math.abs(dx) < DRAG_SLOP_PX) return; // finger jitter
    disarm();
    mode = 'dragging';
    callbacks.onDragMove(dx);
  };

  const end = (confirmDrag: boolean): void => {
    disarm();
    const wasFilling = mode === 'filling';
    mode = 'idle';
    if (wasFilling) callbacks.onFillRelease();
    else if (confirmDrag) callbacks.onDragRelease();
  };

  return {
    grant,
    move,
    release: () => end(true),
    // Termination never confirmed a drag before the fill existed either.
    terminate: () => end(false),
  };
};
