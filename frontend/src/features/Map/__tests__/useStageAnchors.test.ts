/* eslint-env jest */
/* global describe, it, expect */
import { act, renderHook } from '@testing-library/react-native';
import type { LayoutChangeEvent } from 'react-native';

import { useStageAnchors } from '../hooks/useStageAnchors';

const GRID_HEIGHT = 1000;
const SUB_PIXEL_GRID_HEIGHT = 0;

const ROW_INDEX_A = 0;
const ROW_INDEX_B = 1;
const ROW_Y_A = 40;
const ROW_Y_B = 220;

const STAGE_A = 10;
const STAGE_B = 9;
const CELL_Y_A = 12;
const CELL_HEIGHT_A = 96;
const CELL_Y_B = 4;
const CELL_HEIGHT_B = 140;

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
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, 0));
      result.current.onRowLayout(ROW_INDEX_B, layoutEvent(ROW_Y_B, 0));
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
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, 0));
    });
    expect(result.current.anchors[STAGE_A]).toBeCloseTo(
      anchorFor(ROW_Y_A, CELL_Y_A, CELL_HEIGHT_A, GRID_HEIGHT),
    );
  });

  it('reports an empty anchors record when gridHeight is below one pixel', () => {
    const { result } = renderHook(() => useStageAnchors(SUB_PIXEL_GRID_HEIGHT));
    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, 0));
      result.current.onCellLayout(STAGE_A, ROW_INDEX_A, layoutEvent(CELL_Y_A, CELL_HEIGHT_A));
    });
    expect(result.current.anchors).toEqual({});
  });

  it('keeps the anchors object identity stable when identical layout events re-fire', () => {
    const { result } = renderHook(() => useStageAnchors(GRID_HEIGHT));
    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, 0));
      result.current.onCellLayout(STAGE_A, ROW_INDEX_A, layoutEvent(CELL_Y_A, CELL_HEIGHT_A));
    });
    const first = result.current.anchors;

    act(() => {
      result.current.onRowLayout(ROW_INDEX_A, layoutEvent(ROW_Y_A, 0));
      result.current.onCellLayout(STAGE_A, ROW_INDEX_A, layoutEvent(CELL_Y_A, CELL_HEIGHT_A));
    });
    expect(Object.is(result.current.anchors, first)).toBe(true);
  });
});
