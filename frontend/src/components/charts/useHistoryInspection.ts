import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Platform } from 'react-native';

import { formatHistoryValue, VALUE_AXIS_WIDTH } from './HistoryPlot';
import type { ChartPoint } from './types';

import { chartLayout } from '@/design/tokens';

function webInspection(
  selectAt: (_location: number) => void,
  move: (_offset: number) => void,
  setIndex: (_index: number) => void,
  count: number,
) {
  if (Platform.OS !== 'web') return {};
  return {
    onMouseMove: (event: MouseEvent<HTMLElement>) =>
      selectAt(event.clientX - event.currentTarget.getBoundingClientRect().left),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') setIndex(0);
      else if (event.key === 'End') setIndex(count - 1);
      else move(event.key === 'ArrowRight' ? 1 : -1);
    },
  };
}

export function useHistoryInspection(
  points: readonly ChartPoint[],
  measure: string,
  width: number,
  columns: boolean,
) {
  const [selected, setSelected] = useState<number | null>(null);
  const index = Math.min(selected ?? points.length - 1, points.length - 1);
  const point = points[index];
  const selectAt = (location: number) => {
    if (!Number.isFinite(location)) return;
    const extent = Math.max(1, width - VALUE_AXIS_WIDTH - chartLayout.plotInset);
    const ratio = Math.max(0, Math.min(1, (location - VALUE_AXIS_WIDTH) / extent));
    const next = columns
      ? Math.min(points.length - 1, Math.floor(ratio * points.length))
      : Math.round(ratio * Math.max(0, points.length - 1));
    setSelected(next);
  };
  const move = (offset: number) =>
    setSelected(Math.max(0, Math.min(points.length - 1, index + offset)));
  const detail = point
    ? `${point.label} · ${formatHistoryValue(point.value)} ${measure.toLowerCase()}${point.stateLabel ? ` · ${point.stateLabel}` : ''}`
    : 'No history yet.';
  return {
    selected: selected === null ? null : index,
    index,
    detail,
    selectAt,
    move,
    web: webInspection(selectAt, move, setSelected, points.length),
  };
}
