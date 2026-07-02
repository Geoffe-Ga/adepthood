// frontend/features/Map/hooks/useStageAnchors.ts

/**
 * Measure the real, content-driven vertical center of each stage cell so the
 * center-column wave threads through the true row/cell midpoints instead of ten
 * imagined equal bands. Row layout gives each row's grid-relative y; cell layout
 * gives each stage's row-relative y + height. A stage only earns an anchor once
 * both are known and the grid has a drawable height; missing stages fall back to
 * the nominal band center in ``waveGeometry``.
 */

import { useCallback, useRef, useState } from 'react';
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

/** The measured-anchor API consumed by ``MapGrid`` and the wave overlay. */
export interface UseStageAnchorsResult {
  /** Unit-space vertical centers keyed by stage; only fully-measured stages. */
  anchors: StageAnchors;
  /** Record a row's grid-relative y from its onLayout event. */
  onRowLayout: (rowIndex: number, event: LayoutChangeEvent) => void;
  /** Record a stage cell's row-relative y + height from its onLayout event. */
  onCellLayout: (stageNumber: number, rowIndex: number, event: LayoutChangeEvent) => void;
}

/** Resolve every fully-measured stage to its unit-space vertical center. */
const computeAnchors = (
  rowYs: Map<number, number>,
  cells: Map<number, CellMeasurement>,
  gridHeight: number,
): StageAnchors => {
  if (gridHeight < MIN_DRAWABLE_HEIGHT) return {};
  const anchors: Record<number, number> = {};
  for (const [stageNumber, cell] of cells) {
    const rowY = rowYs.get(cell.rowIndex);
    if (rowY === undefined) continue;
    anchors[stageNumber] = (rowY + cell.y + cell.height / 2) / gridHeight;
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
  const rowYsRef = useRef<Map<number, number>>(new Map());
  const cellsRef = useRef<Map<number, CellMeasurement>>(new Map());
  const [anchors, setAnchors] = useState<StageAnchors>({});

  const recompute = useCallback(() => {
    const next = computeAnchors(rowYsRef.current, cellsRef.current, gridHeight);
    setAnchors((prev) => (sameAnchors(prev, next) ? prev : next));
  }, [gridHeight]);

  const onRowLayout = useCallback(
    (rowIndex: number, event: LayoutChangeEvent) => {
      rowYsRef.current.set(rowIndex, event.nativeEvent.layout.y);
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
