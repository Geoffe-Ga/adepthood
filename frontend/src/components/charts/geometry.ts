import type { ChartColumn, ChartPoint, RibbonBlock } from './types';

import { chartLayout } from '@/design/tokens';

/** Keep malformed or all-zero series finite without inventing a visible value. */
export const positive = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;
export const scaleMaximum = (values: readonly number[], max?: number): number =>
  positive(max ?? Math.max(0, ...values)) || 1;
export const scaled = (value: number, max: number, extent: number): number =>
  Math.min(positive(value) / max, 1) * extent;

export const domainY = (value: number, min: number, max: number, height: number): number =>
  height * (1 - (Math.min(max, Math.max(min, value)) - min) / (max - min));

export function columnDomain(columns: readonly ChartColumn[], ask = 0, max?: number, min?: number) {
  const positiveTotals = columns.map((column) =>
    column.segments.reduce((sum, value) => sum + positive(value), 0),
  );
  const negativeTotals = columns.map((column) =>
    column.segments.reduce((sum, value) => sum - positive(-value), 0),
  );
  const bottom = min ?? Math.min(0, ask, ...negativeTotals);
  const top = max ?? Math.max(0, ask, ...positiveTotals);
  return { min: bottom, max: top === bottom ? bottom + 1 : top };
}

function segmentGeometry(value: number, start: number, height: number, max: number, min: number) {
  const end = start + value;
  const from = domainY(start, min, max, height);
  const to = domainY(end, min, max, height);
  const gap = start !== 0 ? chartLayout.gap : 0;
  return {
    y: Math.min(from, to) + (value < 0 ? gap : 0),
    height: Math.max(0, Math.abs(to - from) - gap),
    negative: value < 0,
  };
}

export function columnGeometry(
  columns: readonly ChartColumn[],
  width: number,
  height: number,
  max: number,
  min = 0,
) {
  const slot = width / Math.max(1, columns.length);
  const columnWidth = Math.min(chartLayout.columnMaxWidth, Math.max(0, slot - chartLayout.gap));
  return columns.map((column, index) => {
    let positiveTotal = 0;
    let negativeTotal = 0;
    return column.segments.map((value, segment) => {
      const amount = Number.isFinite(value) ? value : 0;
      const start = amount < 0 ? negativeTotal : positiveTotal;
      if (amount < 0) negativeTotal += amount;
      else positiveTotal += amount;
      return {
        x: index * slot + (slot - columnWidth) / 2,
        width: columnWidth,
        ...segmentGeometry(amount, start, height, max, min),
        segment,
      };
    });
  });
}

/** Rounded at the data end only; the baseline stays square. */
export function columnPath(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
  negative?: boolean;
}): string {
  const { x, y, width, height } = rect;
  const radius = Math.min(chartLayout.columnRadius, width / 2, height / 2);
  if (rect.negative)
    return `M ${x} ${y} V ${y + height - radius} Q ${x} ${y + height} ${x + radius} ${y + height} H ${x + width - radius} Q ${x + width} ${y + height} ${x + width} ${y + height - radius} V ${y} Z`;
  return `M ${x} ${y + height} V ${y + radius} Q ${x} ${y} ${x + radius} ${y} H ${x + width - radius} Q ${x + width} ${y} ${x + width} ${y + radius} V ${y + height} Z`;
}

export function dotGeometry(
  points: readonly ChartPoint[],
  width: number,
  height: number,
  max: number,
) {
  return points.map((point, index) => ({
    x: pointX(index, points.length, width),
    y: height - scaled(point.value, max, height),
  }));
}

export const pointX = (index: number, count: number, width: number): number =>
  count <= 1 ? width / 2 : Math.max(0, Math.min(1, index / (count - 1))) * width;

function fittedAxisLabel(label: string, width: number): string {
  const characters = Math.floor(width / chartLayout.labelSize);
  if (characters < 1) return '';
  return label.length <= characters ? label : `${label.slice(0, characters - 1)}…`;
}

/** Conservative one-em bounds keep month labels inside the plot and apart. */
export function axisTickLabels(
  ticks: readonly { index: number; label: string }[],
  count: number,
  width: number,
) {
  let edge = -chartLayout.gap;
  return ticks.flatMap((tick) => {
    const label = fittedAxisLabel(tick.label, width);
    const labelWidth = label.length * chartLayout.labelSize;
    const left = Math.max(
      0,
      Math.min(width - labelWidth, pointX(tick.index, count, width) - labelWidth / 2),
    );
    if (!label || left < edge + chartLayout.gap) return [];
    edge = left + labelWidth;
    const anchor: 'start' | 'middle' | 'end' =
      left === 0 ? 'start' : edge >= width ? 'end' : 'middle';
    const x = anchor === 'start' ? left : anchor === 'end' ? edge : left + labelWidth / 2;
    return [{ ...tick, label, x, left, anchor, width: labelWidth }];
  });
}

export function ribbonGeometry(blocks: readonly RibbonBlock[], width: number) {
  const total = Math.max(
    1,
    blocks.reduce((sum, block) => sum + positive(block.weeks), 0),
  );
  let offset = 0;
  return blocks.map((block) => {
    const blockWidth = (positive(block.weeks) / total) * width;
    const rect = { x: offset, width: blockWidth };
    offset += blockWidth;
    return rect;
  });
}
