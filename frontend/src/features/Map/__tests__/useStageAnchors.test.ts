/* eslint-env jest */
/* global describe, it, expect */
import { act, renderHook } from '@testing-library/react-native';
import type { LayoutChangeEvent } from 'react-native';

import { useStageAnchors } from '../hooks/useStageAnchors';

const GRID_HEIGHT = 1000;
const SUB_PIXEL_GRID_HEIGHT = 0;
/** The grid after Begin again (or a cycle caption) takes some of its height. */
const SHRUNK_GRID_HEIGHT = 800;

const ROW_INDEX_A = 0;
const ROW_INDEX_B = 1;
const ROW_Y_A = 40;
/** Row A's height: row B starts where it ends, as the bands stack in the grid. */
const ROW_HEIGHT_A = 180;
const ROW_Y_B = ROW_Y_A + ROW_HEIGHT_A;
const ROW_HEIGHT_B = 160;

const STAGE_A = 10;
const STAGE_B = 9;
const CELL_Y_A = 12;
const CELL_HEIGHT_A = 96;
const CELL_Y_B = 4;
const CELL_HEIGHT_B = 140;

/** A band stacking two stages: the upper (higher-numbered) row, then the lower. */
const ROW_INDEX_PAIR = 2;
const ROW_Y_PAIR = ROW_Y_B + ROW_HEIGHT_B;
const ROW_HEIGHT_PAIR = 146;
/** Row B once a label above it takes another line. */
const ROW_HEIGHT_B_GROWN = ROW_HEIGHT_B + 29;
const UPPER_STAGE = 2;
const LOWER_STAGE = 1;
const UPPER_Y = 1;
/** The upper row at first layout, before its locked note has wrapped. */
const UPPER_HEIGHT_FIRST = 42;
/** The upper row once the calendar answers and its note takes three lines. */
const UPPER_HEIGHT_GROWN = 70;
const LOWER_HEIGHT = 75;

const layoutEvent = (y: number, height: number): LayoutChangeEvent =>
  ({ nativeEvent: { layout: { x: 0, y, width: 0, height } } }) as LayoutChangeEvent;

const anchorFor = (rowY: number, cellY: number, cellHeight: number, gridHeight: number): number =>
  (rowY + cellY + cellHeight / 2) / gridHeight;

describe('useStageAnchors', () => {
  it('reports an empty anchors record before any layout event fires', () => {
    const { result } = renderHook(() => useStageAnchors(GRID_HEIGHT));
    expect(result.current.anchors).toEqual({});
  });

  it('resolves each measured stage anchor as (rowY + cellY + cellHeight/2) / gridHeight', () => {
    const { result } = renderHook(() => useStageAnchors(GRID_HEIGHT));
    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, ROW_HEIGHT_A));
      result.current.onRowLayout(ROW_INDEX_B, layoutEvent(ROW_Y_B, ROW_HEIGHT_B));
      result.current.onCellLayout(STAGE_A, ROW_INDEX_A, layoutEvent(CELL_Y_A, CELL_HEIGHT_A));
      result.current.onCellLayout(STAGE_B, ROW_INDEX_B, layoutEvent(CELL_Y_B, CELL_HEIGHT_B));
    });
    expect(result.current.anchors[STAGE_A]).toBeCloseTo(
      anchorFor(ROW_Y_A, CELL_Y_A, CELL_HEIGHT_A, GRID_HEIGHT),
    );
    expect(result.current.anchors[STAGE_B]).toBeCloseTo(
      anchorFor(ROW_Y_B, CELL_Y_B, CELL_HEIGHT_B, GRID_HEIGHT),
    );
  });

  it('omits a stage until BOTH its row and its cell have reported layout', () => {
    const { result } = renderHook(() => useStageAnchors(GRID_HEIGHT));
    act(() => {
      result.current.onCellLayout(STAGE_A, ROW_INDEX_A, layoutEvent(CELL_Y_A, CELL_HEIGHT_A));
    });
    expect(result.current.anchors[STAGE_A]).toBeUndefined();

    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, ROW_HEIGHT_A));
    });
    expect(result.current.anchors[STAGE_A]).toBeCloseTo(
      anchorFor(ROW_Y_A, CELL_Y_A, CELL_HEIGHT_A, GRID_HEIGHT),
    );
  });

  it('reports an empty anchors record when gridHeight is below one pixel', () => {
    const { result } = renderHook(() => useStageAnchors(SUB_PIXEL_GRID_HEIGHT));
    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, ROW_HEIGHT_A));
      result.current.onCellLayout(STAGE_A, ROW_INDEX_A, layoutEvent(CELL_Y_A, CELL_HEIGHT_A));
    });
    expect(result.current.anchors).toEqual({});
  });

  it('keeps the anchors object identity stable when identical layout events re-fire', () => {
    const { result } = renderHook(() => useStageAnchors(GRID_HEIGHT));
    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, ROW_HEIGHT_A));
      result.current.onCellLayout(STAGE_A, ROW_INDEX_A, layoutEvent(CELL_Y_A, CELL_HEIGHT_A));
    });
    const first = result.current.anchors;

    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, ROW_HEIGHT_A));
      result.current.onCellLayout(STAGE_A, ROW_INDEX_A, layoutEvent(CELL_Y_A, CELL_HEIGHT_A));
    });
    expect(Object.is(result.current.anchors, first)).toBe(true);
  });

  // On web ``onLayout`` is a ResizeObserver: a row that keeps its height never
  // re-reports, so the lower row of a band would keep the y it had before the
  // row above it grew, and the wave and lens would sit above the stage.
  it("a later-growing upper row shifts the lower row's anchor without the lower row re-reporting", () => {
    const { result } = renderHook(() => useStageAnchors(GRID_HEIGHT));
    act(() => {
      result.current.onRowLayout(ROW_INDEX_PAIR, layoutEvent(ROW_Y_PAIR, ROW_HEIGHT_PAIR));
      result.current.onCellLayout(
        UPPER_STAGE,
        ROW_INDEX_PAIR,
        layoutEvent(UPPER_Y, UPPER_HEIGHT_FIRST),
      );
      result.current.onCellLayout(
        LOWER_STAGE,
        ROW_INDEX_PAIR,
        layoutEvent(UPPER_Y + UPPER_HEIGHT_FIRST, LOWER_HEIGHT),
      );
    });
    expect(result.current.anchors[LOWER_STAGE]).toBeCloseTo(
      anchorFor(ROW_Y_PAIR, UPPER_Y + UPPER_HEIGHT_FIRST, LOWER_HEIGHT, GRID_HEIGHT),
    );

    act(() => {
      result.current.onCellLayout(
        UPPER_STAGE,
        ROW_INDEX_PAIR,
        layoutEvent(UPPER_Y, UPPER_HEIGHT_GROWN),
      );
    });
    expect(result.current.anchors[UPPER_STAGE]).toBeCloseTo(
      anchorFor(ROW_Y_PAIR, UPPER_Y, UPPER_HEIGHT_GROWN, GRID_HEIGHT),
    );
    expect(result.current.anchors[LOWER_STAGE]).toBeCloseTo(
      anchorFor(ROW_Y_PAIR, UPPER_Y + UPPER_HEIGHT_GROWN, LOWER_HEIGHT, GRID_HEIGHT),
    );
  });

  it("a later-growing upper band shifts the lower band's anchors without the lower band re-reporting", () => {
    const { result } = renderHook(() => useStageAnchors(GRID_HEIGHT));
    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, ROW_HEIGHT_A));
      result.current.onRowLayout(ROW_INDEX_B, layoutEvent(ROW_Y_B, ROW_HEIGHT_B));
      result.current.onRowLayout(ROW_INDEX_PAIR, layoutEvent(ROW_Y_PAIR, ROW_HEIGHT_PAIR));
      result.current.onCellLayout(
        LOWER_STAGE,
        ROW_INDEX_PAIR,
        layoutEvent(UPPER_Y + UPPER_HEIGHT_GROWN, LOWER_HEIGHT),
      );
      result.current.onCellLayout(
        UPPER_STAGE,
        ROW_INDEX_PAIR,
        layoutEvent(UPPER_Y, UPPER_HEIGHT_GROWN),
      );
    });
    expect(result.current.anchors[LOWER_STAGE]).toBeCloseTo(
      anchorFor(ROW_Y_PAIR, UPPER_Y + UPPER_HEIGHT_GROWN, LOWER_HEIGHT, GRID_HEIGHT),
    );

    act(() => {
      result.current.onRowLayout(ROW_INDEX_B, layoutEvent(ROW_Y_B, ROW_HEIGHT_B_GROWN));
    });
    const shiftedRowY = ROW_Y_B + ROW_HEIGHT_B_GROWN;
    expect(result.current.anchors[UPPER_STAGE]).toBeCloseTo(
      anchorFor(shiftedRowY, UPPER_Y, UPPER_HEIGHT_GROWN, GRID_HEIGHT),
    );
    expect(result.current.anchors[LOWER_STAGE]).toBeCloseTo(
      anchorFor(shiftedRowY, UPPER_Y + UPPER_HEIGHT_GROWN, LOWER_HEIGHT, GRID_HEIGHT),
    );
  });

  it("falls back to a row's own measured y when the row above it has not reported", () => {
    const { result } = renderHook(() => useStageAnchors(GRID_HEIGHT));
    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, ROW_HEIGHT_A));
      result.current.onRowLayout(ROW_INDEX_PAIR, layoutEvent(ROW_Y_PAIR, ROW_HEIGHT_PAIR));
      result.current.onCellLayout(
        UPPER_STAGE,
        ROW_INDEX_PAIR,
        layoutEvent(UPPER_Y, UPPER_HEIGHT_FIRST),
      );
    });
    expect(result.current.anchors[UPPER_STAGE]).toBeCloseTo(
      anchorFor(ROW_Y_PAIR, UPPER_Y, UPPER_HEIGHT_FIRST, GRID_HEIGHT),
    );
  });

  // #2657: the rows and cells report their new layout in the same pass that
  // shrinks the grid, so they are normalised by the OLD height, and the grid's
  // own onLayout lands after them. Unless the anchors follow the height, the
  // wave is drawn against stale bands and runs through the stage annotations.
  it('re-resolves every anchor against the new grid height when only the height changes', () => {
    const { result, rerender } = renderHook(
      ({ height }: { height: number }) => useStageAnchors(height),
      {
        initialProps: { height: GRID_HEIGHT },
      },
    );
    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, ROW_HEIGHT_A));
      result.current.onCellLayout(STAGE_A, ROW_INDEX_A, layoutEvent(CELL_Y_A, CELL_HEIGHT_A));
    });

    rerender({ height: SHRUNK_GRID_HEIGHT });

    expect(result.current.anchors[STAGE_A]).toBeCloseTo(
      anchorFor(ROW_Y_A, CELL_Y_A, CELL_HEIGHT_A, SHRUNK_GRID_HEIGHT),
    );
  });
});
