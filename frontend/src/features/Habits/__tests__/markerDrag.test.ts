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

  it('keeps a crowded low drag on the bar, bounded by its neighbour', () => {
    // REWRITTEN (#2892 review): this used to assert BOTH directions settled on 0,
    // which pinned the very defect it was meant to guard -- with the neighbour at
    // 3% the gap subtraction collapsed the window to {0}, so every drop saved the
    // same value however far the star was dragged. The invariant it was really
    // written for is "stays on the bar", and that still holds: far past the
    // neighbour now stops AT the neighbour, far the other way still stops at 0.
    const drag = createMarkerDragController('low');

    drag.start({ barWidthPx: 200, startPercent: 1, neighbourPercent: 3 });

    expect(drag.moveTo(10000)).toBe(3);
    expect(drag.moveTo(-10000)).toBe(0);
  });

  it('keeps a crowded clear drag on the bar, bounded by its neighbour', () => {
    // REWRITTEN (#2892 review): the mirror of the low case above. Dragging back
    // past a neighbour that sits inside the gap now stops AT the neighbour rather
    // than snapping to 100; running off the end still stops at 100.
    const drag = createMarkerDragController('clear');

    drag.start({ barWidthPx: 200, startPercent: 99, neighbourPercent: 98 });

    expect(drag.moveTo(20)).toBe(100);
    expect(drag.moveTo(-10000)).toBe(98);
  });

  it('lets a low drag reach the values below a neighbour that sits inside the gap', () => {
    // Goals low 1 / clear 3 / stretch 100 put the clear star at 3%, inside the
    // 5-point gap. Subtracting the gap would put the ceiling below the floor and
    // collapse the window to {0}, so every drop would save the same value however
    // far it was dragged -- the exact "saves 1 whatever you do" symptom of #2884,
    // reached by geometry instead of by a stale closure. The gap is cosmetic; it
    // must never make a reachable target unreachable.
    const drag = createMarkerDragController('low');

    drag.start({ barWidthPx: 100, startPercent: 1, neighbourPercent: 3 });

    expect(drag.moveTo(1)).toBe(2);
  });

  it('lets a clear drag reach the values above a neighbour that sits inside the gap', () => {
    // The mirror case: a low star at 97% leaves no room for the gap below 100.
    const drag = createMarkerDragController('clear');

    drag.start({ barWidthPx: 100, startPercent: 99, neighbourPercent: 97 });

    expect(drag.moveTo(-1)).toBe(98);
  });

  it('still keeps the cosmetic gap when the bar has room for it', () => {
    const drag = createMarkerDragController('low');

    drag.start({ barWidthPx: 100, startPercent: 10, neighbourPercent: 80 });

    expect(drag.moveTo(85)).toBe(80 - MARKER_MIN_GAP_PCT);
    expect(MARKER_MIN_GAP_PCT).toBe(5);
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
