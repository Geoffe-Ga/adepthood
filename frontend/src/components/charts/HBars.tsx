import React, { useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import { Rect } from 'react-native-svg';

import { ChartFrame, useChartSize } from './ChartFrame';
import { chartStyles } from './chartStyles';
import { scaled, scaleMaximum } from './geometry';
import { Plot } from './Plot';
import type { ChartBaseProps, ChartTableRow } from './types';

import { accent, chart, chartLayout } from '@/design/tokens';

export interface HBar {
  label: string;
  value: number;
}

export interface HBarsProps extends ChartBaseProps {
  bars: readonly HBar[];
  max?: number;
}

export const barTableRows = (bars: readonly HBar[]): ChartTableRow[] =>
  bars.map((bar) => ({ label: bar.label, values: [bar.value] }));

/** One label reserve preserves the same numeric scale across every bar. */
function useValueLabelWidths(bars: readonly HBar[], containerWidth: number) {
  const [measurements, setMeasurements] = useState<Record<string, number>>({});
  const key = (label: string) => `${containerWidth}:${label}`;
  const reserved = Math.max(
    0,
    ...bars.map((bar) => {
      const label = String(bar.value);
      return measurements[key(label)] ?? label.length * chartLayout.labelSize;
    }),
  );
  const measure = (label: string, event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    const labelKey = key(label);
    setMeasurements((previous) =>
      previous[labelKey] === width ? previous : { ...previous, [labelKey]: width },
    );
  };
  return { reserved, measure };
}

function BarShape({ width, color, label }: { width: number; color: string; label: string }) {
  return (
    <View style={[chartStyles.barGraphic, { width }]}>
      <Plot width={Math.max(1, width)} height={chartLayout.ribbonHeight}>
        <Rect
          testID={`hbar-${label}`}
          x={0}
          y={chartLayout.gap}
          width={width}
          height={chartLayout.ribbonHeight - chartLayout.gap * 2}
          rx={chartLayout.columnRadius}
          fill={color}
        />
      </Plot>
    </View>
  );
}

function BarRow({
  bar,
  maximum,
  width,
  strongest,
  measurement,
}: {
  bar: HBar;
  maximum: number;
  width: number;
  strongest: number;
  measurement: { reserved: number; measure: (_label: string, _event: LayoutChangeEvent) => void };
}) {
  const label = String(bar.value);
  const barWidth = scaled(
    bar.value,
    maximum,
    Math.max(0, width - measurement.reserved - chartLayout.plotInset),
  );
  return (
    <View>
      <Text style={chartStyles.caption}>{bar.label}</Text>
      <View style={chartStyles.barLine}>
        <BarShape
          width={barWidth}
          label={bar.label}
          color={bar.value === strongest ? accent.primary : chart.dim}
        />
        <Text onLayout={(event) => measurement.measure(label, event)} style={chartStyles.barValue}>
          {label}
        </Text>
      </View>
    </View>
  );
}

export function HBars({ bars, max, ...base }: HBarsProps) {
  const size = useChartSize(base.width, base.height);
  const measurement = useValueLabelWidths(bars, size.width);
  const values = bars.map((bar) => bar.value);
  const maximum = scaleMaximum(values, max);
  const strongest = Math.max(0, ...values);
  return (
    <ChartFrame {...base} onLayout={size.onLayout} rows={barTableRows(bars)} headers={['Value']}>
      {bars.map((bar, index) => (
        <BarRow
          key={index}
          bar={bar}
          maximum={maximum}
          strongest={strongest}
          width={size.width}
          measurement={measurement}
        />
      ))}
    </ChartFrame>
  );
}
