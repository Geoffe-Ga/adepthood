/**
 * Measure the real, content-driven vertical center of each stage cell so the
 * center-column wave threads through the true row/cell midpoints instead of ten
 * imagined equal bands. Row layout gives each row's grid-relative y; cell layout
 * gives each stage's row-relative y + height. A stage only earns an anchor once
 * both are known and the grid has a drawable height; missing stages fall back to
 * the nominal band center in ``waveGeometry``.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

import type { StageAnchors } from '../waveGeometry';

/** Smallest grid height worth resolving; below it there is nothing to anchor. */
const MIN_DRAWABLE_HEIGHT = 1;

/** A stage cell's raw row-relative measurement plus the row it belongs to. */
interface CellMeasurement {
  rowIndex: number;
  y: number;
  height: number;
}

/** A row's raw grid-relative measurement. */
interface RowMeasurement {
  y: number;
  height: number;
}

/** The measured-anchor API consumed by ``MapGrid`` and the wave overlay. */
export interface UseStageAnchorsResult {
  /** Unit-space vertical centers keyed by stage; only fully-measured stages. */
  anchors: StageAnchors;
  /** Record a row's grid-relative y and height from its onLayout event. */
  onRowLayout: (rowIndex: number, event: LayoutChangeEvent) => void;
  /** Record a stage cell's row-relative y + height from its onLayout event. */
  onCellLayout: (stageNumber: number, rowIndex: number, event: LayoutChangeEvent) => void;
}

/**
 * Each row's cells in the order they stack down the band: a band lists its
 * stages top-down in descending stage number (``MAP_ROWS``), so the higher
 * stage's row sits above the lower's.
 */
const cellsByRow = (cells: Map<number, CellMeasurement>): Map<number, number[]> => {
  const rows = new Map<number, number[]>();
  for (const [stageNumber, cell] of cells) {
    rows.set(cell.rowIndex, [...(rows.get(cell.rowIndex) ?? []), stageNumber]);
  }
  for (const stages of rows.values()) stages.sort((a, b) => b - a);
  return rows;
};

/**
 * Each row's grid-relative top, derived: the topmost measured row's own y, then
 * every row below it starts where the row above ends (the bands are stacked
 * with no gap; a band's rule is drawn inside its box). Rows are keyed by their
 * index down the grid.
 */
const derivedRowYs = (rows: Map<number, RowMeasurement>): Map<number, number> => {
  const indices = [...rows.keys()].sort((a, b) => a - b);
  const tops = new Map<number, number>();
  let offset: number | null = null;
  let previous: number | null = null;
  for (const index of indices) {
    const row = rows.get(index);
    if (row === undefined) continue;
    // A row whose upper neighbour has not reported yet keeps its own y: the
    // chain of heights only holds across rows that are actually contiguous.
    if (offset === null || previous !== index - 1) offset = row.y;
    tops.set(index, offset);
    offset += row.height;
    previous = index;
  }
  return tops;
};

/**
 * Resolve every fully-measured stage to its unit-space vertical center. A
 * row's top, and a cell's offset inside its band, are derived from the
 * measured heights of what sits above them, never from their own measured y:
 * on web ``onLayout`` is a ResizeObserver, so a band or cell that keeps its
 * height while something above it grows (a locked note wrapping once the
 * calendar answers, a fitted label taking its lines) never re-reports, and its
 * stale y would park the wave -- and the lens -- above the stage it belongs
 * to. Heights always re-report.
 */
const computeAnchors = (
  rows: Map<number, RowMeasurement>,
  cells: Map<number, CellMeasurement>,
  gridHeight: number,
): StageAnchors => {
  if (gridHeight < MIN_DRAWABLE_HEIGHT) return {};
  const anchors: Record<number, number> = {};
  const rowYs = derivedRowYs(rows);
  for (const [rowIndex, stages] of cellsByRow(cells)) {
    const rowY = rowYs.get(rowIndex);
    if (rowY === undefined) continue;
    let offset: number | null = null;
    for (const stageNumber of stages) {
      const cell = cells.get(stageNumber);
      if (cell === undefined) continue;
      offset ??= cell.y;
      anchors[stageNumber] = (rowY + offset + cell.height / 2) / gridHeight;
      offset += cell.height;
    }
  }
  return anchors;
};

/** Whether two anchor records hold the same stages with the same values. */
const sameAnchors = (a: StageAnchors, b: StageAnchors): boolean => {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[Number(key)] === b[Number(key)]);
};

/**
 * Track measured stage anchors from row/cell layout events. Raw measurements
 * live in refs; ``anchors`` only re-identifies when its resolved contents
 * actually change, so re-fired identical layouts never re-render the overlay.
 */
export const useStageAnchors = (gridHeight: number): UseStageAnchorsResult => {
  const rowsRef = useRef<Map<number, RowMeasurement>>(new Map());
  const cellsRef = useRef<Map<number, CellMeasurement>>(new Map());
  const [anchors, setAnchors] = useState<StageAnchors>({});

  const recompute = useCallback(() => {
    const next = computeAnchors(rowsRef.current, cellsRef.current, gridHeight);
    setAnchors((prev) => (sameAnchors(prev, next) ? prev : next));
  }, [gridHeight]);

  // The rows and cells report a resize in the same pass that resizes the grid,
  // so they were normalised by the height it had before; the grid's own
  // onLayout lands after them and fires nothing here. Re-resolve on every new
  // height, or the wave is drawn against stale bands (#2657) -- as it was
  // whenever Begin again or the cycle caption took height from the grid.
  useEffect(() => {
    recompute();
  }, [recompute]);

  const onRowLayout = useCallback(
    (rowIndex: number, event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      rowsRef.current.set(rowIndex, { y, height });
      recompute();
    },
    [recompute],
  );

  const onCellLayout = useCallback(
    (stageNumber: number, rowIndex: number, event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      cellsRef.current.set(stageNumber, { rowIndex, y, height });
      recompute();
    },
    [recompute],
  );

  return { anchors, onRowLayout, onCellLayout };
};
