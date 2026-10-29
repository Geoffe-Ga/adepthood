import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChartFrame, useChartSize } from './ChartFrame';
import { chartStyles } from './chartStyles';
import { formatHistoryValue, HistoryPlot, VALUE_AXIS_WIDTH } from './HistoryPlot';
import type { ChartBaseProps, ChartPoint, ChartTableRow } from './types';
import { useHistoryInspection } from './useHistoryInspection';

import { accent, chartLayout, ink } from '@/design/tokens';

const COMPACT_HEIGHT = 56;
export interface HistoryChartProps extends ChartBaseProps {
  points: readonly ChartPoint[];
  /** What is plotted: the header row's title and the table's value column. */
  measure: string;
  /** Spoken after each figure in the readout and the header, e.g. `sets a day`. */
  unit?: string;
  /** How a value is written on the axis, in the readout and in the table. */
  format?: (_value: number) => string;
  /** The current figure shown on the header row. */
  aside?: string;
  color?: string;
  max?: number;
  /**
   * A sparkline for a list of rows that share one date range: no value axis,
   * no date ticks, and a readout only while a point is selected.
   */
  compact?: boolean;
  variant?: 'line' | 'columns';
}

type Inspection = ReturnType<typeof useHistoryInspection>;

function DateTicks({ points }: { points: readonly ChartPoint[] }) {
  return (
    <View style={chartStyles.axis}>
      <Text style={chartStyles.tick}>{points[0]?.label}</Text>
      {points.length > 1 ? <Text style={chartStyles.tick}>{points.at(-1)?.label}</Text> : null}
    </View>
  );
}

/** The selected point, or the latest one until a reader picks another. */
function Readout({
  compact,
  inspection,
  testID,
}: {
  compact: boolean;
  inspection: Inspection;
  testID?: string;
}) {
  if (compact && inspection.selected === null) return null;
  return (
    <Text testID={`${testID}-value`} style={[chartStyles.tick, styles.detail]}>
      {inspection.detail}
    </Text>
  );
}

function HistoryInspector({
  points,
  summary,
  testID,
  inspection,
  children,
}: Pick<HistoryChartProps, 'points' | 'summary' | 'testID'> & {
  inspection: Inspection;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      testID={`${testID}-inspect`}
      accessibilityRole="adjustable"
      accessibilityLabel={summary}
      accessibilityHint="Tap to inspect a date. Use left and right arrow keys to move through the history."
      accessibilityValue={
        points.length > 0
          ? { min: 0, max: points.length - 1, now: inspection.index, text: inspection.detail }
          : undefined
      }
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) =>
        inspection.move(event.nativeEvent.actionName === 'increment' ? 1 : -1)
      }
      onPress={(event) => inspection.selectAt(event.nativeEvent.locationX)}
      {...inspection.web}
    >
      {children}
    </Pressable>
  );
}

const tableRows = (
  points: readonly ChartPoint[],
  format: (_value: number) => string,
): ChartTableRow[] =>
  points.map((point) => ({
    label: point.label,
    values: [format(point.value), ...(point.stateLabel ? [point.stateLabel] : [])],
  }));

interface HistoryModelInput {
  points: readonly ChartPoint[];
  unit?: string;
  format: (_value: number) => string;
  max?: number;
  compact: boolean;
  columns: boolean;
  width?: number;
  height?: number;
}

/** Geometry, domain and inspection for one history, independent of how it is framed. */
function useHistoryModel({
  points,
  unit,
  format,
  max,
  compact,
  columns,
  ...box
}: HistoryModelInput) {
  const size = useChartSize(
    box.width,
    box.height ?? (compact ? COMPACT_HEIGHT : chartLayout.height),
  );
  const axisWidth = compact ? 0 : VALUE_AXIS_WIDTH;
  const figure = (value: number) => (unit ? `${format(value)} ${unit}` : format(value));
  const values = points.map((point) => point.value);
  const min = Math.min(0, ...values);
  const maximum = Math.max(max ?? 0, ...values) || (min < 0 ? 0 : 1);
  const inspection = useHistoryInspection(points, figure, {
    width: size.width,
    axisWidth,
    columns,
  });
  return { size, axisWidth, figure, min, maximum, inspection };
}

type HistoryModel = ReturnType<typeof useHistoryModel>;

const plotBounds = (model: HistoryModel) => ({
  width: model.size.width,
  height: model.size.height,
  min: model.min,
  max: model.maximum,
  selected: model.inspection.selected,
  axisWidth: model.axisWidth,
});

/** One inspectable timeline for native touch, web hover, keyboard and table readers. */
export function HistoryChart({
  points,
  measure,
  unit,
  format = formatHistoryValue,
  aside,
  color = accent.primary,
  max,
  compact = false,
  variant = 'line',
  ...base
}: HistoryChartProps) {
  const columns = variant === 'columns';
  const model = useHistoryModel({ ...base, points, unit, format, max, compact, columns });
  return (
    <ChartFrame
      {...base}
      onLayout={model.size.onLayout}
      interactive
      title={measure}
      aside={aside}
      rows={tableRows(points, model.figure)}
      headers={[measure, 'Details']}
    >
      <HistoryInspector
        points={points}
        summary={base.summary}
        testID={base.testID}
        inspection={model.inspection}
      >
        <HistoryPlot
          {...plotBounds(model)}
          points={points}
          color={color}
          variant={variant}
          format={format}
        />
      </HistoryInspector>
      {compact ? null : <DateTicks points={points} />}
      <Readout compact={compact} inspection={model.inspection} testID={base.testID} />
    </ChartFrame>
  );
}

const styles = StyleSheet.create({ detail: { color: ink.primary } });
