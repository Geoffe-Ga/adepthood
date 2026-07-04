import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createMarkerGesture, type MarkerGestureCallbacks } from '../markerGesture';
import { DRAG_SLOP_PX, STAR_LONG_PRESS_MS } from '../starFill';

const makeCallbacks = (): jest.Mocked<MarkerGestureCallbacks> => ({
  onFillStart: jest.fn(),
  onFillRelease: jest.fn(),
  onDragMove: jest.fn(),
  onDragRelease: jest.fn(),
});

describe('createMarkerGesture', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts a fill after the long-press threshold and releases it on release', () => {
    const cb = makeCallbacks();
    const gesture = createMarkerGesture(cb);

    gesture.grant();
    expect(cb.onFillStart).not.toHaveBeenCalled();
    jest.advanceTimersByTime(STAR_LONG_PRESS_MS);
    expect(cb.onFillStart).toHaveBeenCalledTimes(1);

    gesture.release();
    expect(cb.onFillRelease).toHaveBeenCalledTimes(1);
    expect(cb.onDragMove).not.toHaveBeenCalled();
    expect(cb.onDragRelease).not.toHaveBeenCalled();
  });

  it('ignores sub-slop jitter so a slightly wobbly hold still fills', () => {
    const cb = makeCallbacks();
    const gesture = createMarkerGesture(cb);

    gesture.grant();
    gesture.move(DRAG_SLOP_PX - 1);
    jest.advanceTimersByTime(STAR_LONG_PRESS_MS);

    expect(cb.onFillStart).toHaveBeenCalledTimes(1);
    expect(cb.onDragMove).not.toHaveBeenCalled();
  });

  it('cancels the pending fill and drags once movement crosses the slop', () => {
    const cb = makeCallbacks();
    const gesture = createMarkerGesture(cb);

    gesture.grant();
    gesture.move(DRAG_SLOP_PX + 4);
    jest.advanceTimersByTime(STAR_LONG_PRESS_MS * 2);

    expect(cb.onFillStart).not.toHaveBeenCalled();
    expect(cb.onDragMove).toHaveBeenCalledWith(DRAG_SLOP_PX + 4);

    gesture.release();
    expect(cb.onDragRelease).toHaveBeenCalledTimes(1);
    expect(cb.onFillRelease).not.toHaveBeenCalled();
  });

  it('keeps forwarding small moves once dragging has started', () => {
    const cb = makeCallbacks();
    const gesture = createMarkerGesture(cb);

    gesture.grant();
    gesture.move(DRAG_SLOP_PX + 2);
    gesture.move(1);

    expect(cb.onDragMove).toHaveBeenCalledTimes(2);
    expect(cb.onDragMove).toHaveBeenLastCalledWith(1);
  });

  it('ignores moves while the fill owns the gesture', () => {
    const cb = makeCallbacks();
    const gesture = createMarkerGesture(cb);

    gesture.grant();
    jest.advanceTimersByTime(STAR_LONG_PRESS_MS);
    gesture.move(50);

    expect(cb.onDragMove).not.toHaveBeenCalled();
  });

  it('treats a quick tap as a drag release (existing confirm behavior)', () => {
    const cb = makeCallbacks();
    const gesture = createMarkerGesture(cb);

    gesture.grant();
    gesture.release();
    jest.advanceTimersByTime(STAR_LONG_PRESS_MS * 2);

    expect(cb.onDragRelease).toHaveBeenCalledTimes(1);
    expect(cb.onFillStart).not.toHaveBeenCalled();
    expect(cb.onFillRelease).not.toHaveBeenCalled();
  });

  it('releases an active fill on terminate without confirming a drag', () => {
    const cb = makeCallbacks();
    const gesture = createMarkerGesture(cb);

    gesture.grant();
    jest.advanceTimersByTime(STAR_LONG_PRESS_MS);
    gesture.terminate();

    expect(cb.onFillRelease).toHaveBeenCalledTimes(1);
    expect(cb.onDragRelease).not.toHaveBeenCalled();
  });

  it('disarms the pending fill on terminate before the threshold', () => {
    const cb = makeCallbacks();
    const gesture = createMarkerGesture(cb);

    gesture.grant();
    gesture.terminate();
    jest.advanceTimersByTime(STAR_LONG_PRESS_MS * 2);

    expect(cb.onFillStart).not.toHaveBeenCalled();
    expect(cb.onFillRelease).not.toHaveBeenCalled();
    expect(cb.onDragRelease).not.toHaveBeenCalled();
  });

  it('supports a fresh gesture after a completed one', () => {
    const cb = makeCallbacks();
    const gesture = createMarkerGesture(cb);

    gesture.grant();
    jest.advanceTimersByTime(STAR_LONG_PRESS_MS);
    gesture.release();

    gesture.grant();
    jest.advanceTimersByTime(STAR_LONG_PRESS_MS);
    expect(cb.onFillStart).toHaveBeenCalledTimes(2);
  });
});
