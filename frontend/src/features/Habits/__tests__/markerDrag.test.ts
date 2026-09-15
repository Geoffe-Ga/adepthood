import { describe, expect, it } from '@jest/globals';

import { createMarkerDragController, MARKER_MIN_GAP_PCT } from '../markerDrag';

describe('createMarkerDragController', () => {
  it('settles on the anchor percent when the finger never moves', () => {
    const drag = createMarkerDragController('low');

    drag.start({ barWidthPx: 200, startPercent: 25, neighbourPercent: 75 });

    expect(drag.settled()).toBe(25);
  });

  it('reports the position a tap started from even when the neighbour window excludes it', () => {
    // A crowded goal set: the clear marker's window is [100, 100], but a tap
    // must confirm where the star actually IS, not where a gap correction
    // would have pushed it. Only `moveTo` applies the window.
    const drag = createMarkerDragController('clear');

    drag.start({ barWidthPx: 200, startPercent: 98, neighbourPercent: 98 });

    expect(drag.settled()).toBe(98);
  });

  it('converts a drag distance into the dropped percent of the bar', () => {
    const drag = createMarkerDragController('low');

    drag.start({ barWidthPx: 200, startPercent: 20, neighbourPercent: 80 });

    expect(drag.moveTo(100)).toBe(70);
    expect(drag.settled()).toBe(70);
  });

  it('never drives a low marker negative, even against a zeroed neighbour', () => {
    // This reproduces the literal frozen `clearMarker === 0` of #2884: the
    // separation must not be able to push the result off the bar.
    const drag = createMarkerDragController('low');

    drag.start({ barWidthPx: 200, startPercent: 25, neighbourPercent: 0 });

    expect(drag.moveTo(100)).toBe(0);
  });

  it('stops a low drag a fixed gap short of its neighbour', () => {
    const drag = createMarkerDragController('low');

    drag.start({ barWidthPx: 200, startPercent: 25, neighbourPercent: 80 });

    // Spelled out rather than derived from the constant, so widening or
    // narrowing the gap is a behaviour change this spec notices.
    expect(MARKER_MIN_GAP_PCT).toBe(5);
    expect(drag.moveTo(10000)).toBe(75);
  });

  it('keeps a crowded low drag on the bar instead of behind its start', () => {
    const drag = createMarkerDragController('low');

    drag.start({ barWidthPx: 200, startPercent: 1, neighbourPercent: 3 });

    expect(drag.moveTo(10000)).toBe(0);
    expect(drag.moveTo(-10000)).toBe(0);
  });

  it('keeps a crowded clear drag on the bar instead of past its end', () => {
    const drag = createMarkerDragController('clear');

    drag.start({ barWidthPx: 200, startPercent: 99, neighbourPercent: 98 });

    expect(drag.moveTo(20)).toBe(100);
    expect(drag.moveTo(-10000)).toBe(100);
  });

  it('makes the drag inert while the bar has not laid out', () => {
    const drag = createMarkerDragController('low');

    drag.start({ barWidthPx: 0, startPercent: 25, neighbourPercent: 75 });

    expect(drag.moveTo(50)).toBe(25);
    expect(drag.moveTo(0)).toBe(25);
    expect(Number.isNaN(drag.settled())).toBe(false);
    expect(drag.settled()).toBe(25);
  });

  it('re-anchors on start so one gesture does not bleed into the next', () => {
    const drag = createMarkerDragController('low');

    drag.start({ barWidthPx: 200, startPercent: 20, neighbourPercent: 80 });
    drag.moveTo(100);

    drag.start({ barWidthPx: 200, startPercent: 10, neighbourPercent: 80 });

    expect(drag.moveTo(0)).toBe(10);
  });
});
