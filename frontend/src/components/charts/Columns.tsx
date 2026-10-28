import React from 'react';
import { G, Line, Path } from 'react-native-svg';

import { ChartFrame, ChartLegend, useChartSize } from './ChartFrame';
import { columnDomain, columnGeometry, columnPath, domainY } from './geometry';
import { AskLabel, AskLine, AxisLabels, Plot } from './Plot';
import type { ChartAsk, ChartBaseProps, ChartColumn, ChartTableRow } from './types';

import { chart, chartLayout, surface } from '@/design/tokens';

export interface ColumnsProps extends ChartBaseProps {
  columns: readonly ChartColumn[];
  seriesLabels?: readonly string[];
  seriesColors?: readonly string[];
  max?: number;
  min?: number;
  ask?: ChartAsk;
}

export const columnTableRows = (columns: readonly ChartColumn[]): ChartTableRow[] =>
  columns.map((column) => ({
    label: column.label,
    values: [...column.segments, ...(column.quiet === undefined ? [] : [column.quiet])],
  }));

function ColumnMarks({
  columns,
  width,
  height,
  max,
  min,
  colors,
}: {
  columns: readonly ChartColumn[];
  width: number;
  height: number;
  max: number;
  min: number;
  colors: readonly string[];
}) {
  return (
    <>
      {columnGeometry(columns, width, height, max, min).map((segments, index) => (
        <G key={index} opacity={columns[index]?.emphasis === false ? 0.5 : 1}>
          {segments.map((segment) =>
            segment.height > 0 ? (
              <Path
                key={segment.segment}
                testID={`columns-${index}-${segment.segment}`}
                d={columnPath(segment)}
                fill={colors[segment.segment] ?? chart.tier[0]}
              />
            ) : null,
          )}
        </G>
      ))}
    </>
  );
}

function ColumnPlot({
  columns,
  size,
  domain,
  colors,
  ask,
}: {
  columns: readonly ChartColumn[];
  size: { width: number; height: number };
  domain: { min: number; max: number };
  colors: readonly string[];
  ask?: ChartAsk;
}) {
  const height = Math.max(1, size.height - chartLayout.plotInset);
  const baseline = domainY(0, domain.min, domain.max, height);
  return (
    <Plot width={size.width} height={size.height}>
      <ColumnMarks
        columns={columns}
        width={size.width}
        height={height}
        {...domain}
        colors={colors}
      />
      <Line
        x1={0}
        x2={size.width}
        y1={baseline}
        y2={baseline}
        stroke={surface.hairline}
        strokeWidth={chartLayout.hairlineWidth}
      />
      <AskLine ask={ask} width={size.width} height={height} {...domain} />
    </Plot>
  );
}

export function Columns({
  columns,
  seriesLabels = ['Value'],
  seriesColors = chart.tier,
  max,
  min,
  ask,
  ...base
}: ColumnsProps) {
  const size = useChartSize(base.width, base.height);
  const domain = columnDomain(columns, ask?.value, max, min);
  return (
    <ChartFrame
      {...base}
      onLayout={size.onLayout}
      rows={columnTableRows(columns)}
      headers={[...seriesLabels, 'Quiet']}
    >
      <AskLabel ask={ask} />
      <ColumnPlot columns={columns} size={size} domain={domain} colors={seriesColors} ask={ask} />
      <AxisLabels
        first={columns[0]?.label}
        last={columns.length > 1 ? columns.at(-1)?.label : undefined}
      />
      <ChartLegend
        items={seriesLabels.map((label, index) => ({
          label,
          color: seriesColors[index] ?? chart.tier[0],
        }))}
      />
    </ChartFrame>
  );
}
