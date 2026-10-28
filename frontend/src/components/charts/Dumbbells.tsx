import React from 'react';
import { Text, View } from 'react-native';
import { Circle, Line } from 'react-native-svg';

import { ChartFrame, ChartLegend, useChartSize } from './ChartFrame';
import { chartStyles } from './chartStyles';
import { Plot } from './Plot';
import type { ChartBaseProps, ChartTableRow } from './types';

import { accent, chart, chartLayout } from '@/design/tokens';

/** One row: an earlier value and a later one on the same 0..max scale. */
export interface Dumbbell {
  label: string;
  /** The earlier pass; null when there was none to compare with. */
  from: number | null;
  to: number;
}

export interface DumbbellsProps extends ChartBaseProps {
  rows: readonly Dumbbell[];
  /** Legend and table headers for the earlier and later values. */
  fromLabel: string;
  toLabel: string;
  max?: number;
  /** How a value reads in the table twin (e.g. as a percentage). */
  format?: (_value: number) => string;
}

const DEFAULT_MAX = 1;
const identity = (value: number): string => String(value);

export const dumbbellTableRows = (
  rows: readonly Dumbbell[],
  format: (_value: number) => string = identity,
): ChartTableRow[] =>
  rows.map((row) => ({
    label: row.label,
    values: [row.from === null ? '—' : format(row.from), format(row.to)],
  }));

function DumbbellRow({ row, width, max }: { row: Dumbbell; width: number; max: number }) {
  const radius = chartLayout.dotRadius;
  const span = Math.max(0, width - radius * 2);
  const x = (value: number) => radius + (Math.min(Math.max(value, 0), max) / max) * span;
  const y = chartLayout.ribbonHeight / 2;
  return (
    <View>
      <Text style={chartStyles.caption}>{row.label}</Text>
      <Plot width={Math.max(1, width)} height={chartLayout.ribbonHeight}>
        {row.from === null ? null : (
          <>
            <Line
              x1={x(row.from)}
              x2={x(row.to)}
              y1={y}
              y2={y}
              stroke={chart.dim}
              strokeWidth={chartLayout.lineWidth}
            />
            <Circle
              testID={`dumbbell-from-${row.label}`}
              cx={x(row.from)}
              cy={y}
              r={radius}
              fill={chart.tier[0]}
            />
          </>
        )}
        <Circle
          testID={`dumbbell-to-${row.label}`}
          cx={x(row.to)}
          cy={y}
          r={radius}
          fill={accent.primary}
        />
      </Plot>
    </View>
  );
}

/** Earlier and later values per row, joined by a quiet line; no row is ranked. */
export function Dumbbells({
  rows,
  fromLabel,
  toLabel,
  max = DEFAULT_MAX,
  format = identity,
  ...base
}: DumbbellsProps) {
  const size = useChartSize(base.width, base.height);
  return (
    <ChartFrame
      {...base}
      onLayout={size.onLayout}
      rows={dumbbellTableRows(rows, format)}
      headers={[fromLabel, toLabel]}
    >
      {rows.map((row, index) => (
        <DumbbellRow key={index} row={row} width={size.width} max={max > 0 ? max : DEFAULT_MAX} />
      ))}
      <ChartLegend
        items={[
          { label: fromLabel, color: chart.tier[0] },
          { label: toLabel, color: accent.primary },
        ]}
      />
    </ChartFrame>
  );
}
