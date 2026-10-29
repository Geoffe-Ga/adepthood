import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChartFrame, useChartSize } from './ChartFrame';
import { chartStyles } from './chartStyles';
import { pointTableRows } from './DotStrip';
import { HistoryPlot } from './HistoryPlot';
import type { ChartBaseProps, ChartPoint } from './types';
import { useHistoryInspection } from './useHistoryInspection';

import { accent, chartLayout, ink } from '@/design/tokens';

const COMPACT_HEIGHT = 72;
export interface HistoryChartProps extends ChartBaseProps {
  points: readonly ChartPoint[];
  measure: string;
  color?: string;
  max?: number;
  compact?: boolean;
  variant?: 'line' | 'columns';
}

type Inspection = ReturnType<typeof useHistoryInspection>;
function HistoryLabels({
  points,
  compact,
  inspection,
  testID,
}: Pick<HistoryChartProps, 'points' | 'compact' | 'testID'> & { inspection: Inspection }) {
  return (
    <>
      <View style={chartStyles.axis}>
        <Text style={chartStyles.tick}>{points[0]?.label}</Text>
        {!compact ? <Text style={chartStyles.caption}>Date</Text> : null}
        {points.length > 1 ? <Text style={chartStyles.tick}>{points.at(-1)?.label}</Text> : null}
      </View>
      {inspection.selected === null ? (
        !compact ? (
          <Text style={chartStyles.caption}>Hover or tap to explore values.</Text>
        ) : null
      ) : (
        <Text testID={`${testID}-value`} style={[chartStyles.tick, styles.detail]}>
          {inspection.detail}
        </Text>
      )}
    </>
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

/** One inspectable timeline for native touch, web hover, keyboard and table readers. */
export function HistoryChart({
  points,
  measure,
  color = accent.primary,
  max,
  compact = false,
  variant = 'line',
  ...base
}: HistoryChartProps) {
  const height = base.height ?? (compact ? COMPACT_HEIGHT : chartLayout.height);
  const size = useChartSize(base.width, height);
  const min = Math.min(0, ...points.map((point) => point.value));
  const maximum = Math.max(max ?? 0, ...points.map((point) => point.value)) || (min < 0 ? 0 : 1);
  const inspection = useHistoryInspection(points, measure, size.width, variant === 'columns');
  const bounds = { width: size.width, height: size.height, min, max: maximum };
  return (
    <ChartFrame
      {...base}
      onLayout={size.onLayout}
      interactive
      rows={pointTableRows(points)}
      headers={[measure, 'Details']}
    >
      <Text style={chartStyles.caption}>{measure}</Text>
      <HistoryInspector
        points={points}
        summary={base.summary}
        testID={base.testID}
        inspection={inspection}
      >
        <HistoryPlot
          points={points}
          {...bounds}
          color={color}
          variant={variant}
          selected={inspection.selected}
        />
      </HistoryInspector>
      <HistoryLabels
        points={points}
        compact={compact}
        inspection={inspection}
        testID={base.testID}
      />
    </ChartFrame>
  );
}

const styles = StyleSheet.create({ detail: { color: ink.primary } });
