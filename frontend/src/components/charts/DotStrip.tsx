import React from 'react';
import { Circle, G, Line, Text as SvgText } from 'react-native-svg';

import { ChartFrame, useChartSize } from './ChartFrame';
import { dotGeometry, scaleMaximum } from './geometry';
import { AskLabel, AskLine, AxisLabels, Plot } from './Plot';
import type { ChartAsk, ChartBaseProps, ChartPoint, ChartTableRow } from './types';

import { accent, chartLayout, ink, surface } from '@/design/tokens';

export interface DotStripProps extends ChartBaseProps {
  points: readonly ChartPoint[];
  max?: number;
  ask?: ChartAsk;
  /** Optional native-unit axis labels; default geometry is unchanged. */
  yTicks?: readonly number[];
  /** Native-unit header for the table twin. */
  valueHeader?: string;
}

export const pointTableRows = (points: readonly ChartPoint[]): ChartTableRow[] =>
  points.map((point) => ({
    label: point.label,
    values: [
      point.value,
      ...(point.stateLabel ? [point.stateLabel] : []),
      ...(point.stateLabel || point.hollow === undefined
        ? []
        : [point.hollow ? 'Partial' : 'Completed']),
    ],
  }));

function DotMarks({
  points,
  width,
  height,
  max,
}: {
  points: readonly ChartPoint[];
  width: number;
  height: number;
  max: number;
}) {
  return (
    <>
      {dotGeometry(points, width, height, max).map((point, index) => (
        <G key={index}>
          <Circle
            cx={point.x}
            cy={point.y}
            r={chartLayout.dotRadius + chartLayout.lineWidth + chartLayout.hairlineWidth / 2}
            fill={surface.canvas}
          />
          <Circle
            testID={`dot-strip-point-${index}`}
            cx={point.x}
            cy={point.y}
            r={chartLayout.dotRadius}
            fill={points[index]?.hollow ? surface.canvas : accent.primary}
            stroke={accent.primary}
            strokeWidth={chartLayout.hairlineWidth}
          />
        </G>
      ))}
    </>
  );
}

function YAxisTicks({
  ticks,
  axisWidth,
  height,
  maximum,
}: {
  ticks?: readonly number[];
  axisWidth: number;
  height: number;
  maximum: number;
}) {
  return (
    <>
      {ticks?.map((tick) => (
        <SvgText
          key={tick}
          x={axisWidth - chartLayout.plotInset}
          y={chartLayout.plotInset + height - Math.min(Math.max(tick, 0) / maximum, 1) * height}
          fill={ink.muted}
          fontSize={chartLayout.labelSize}
          textAnchor="end"
          alignmentBaseline="middle"
        >
          {String(tick)}
        </SvgText>
      ))}
    </>
  );
}

export function DotStrip({
  points,
  ask,
  max,
  yTicks,
  valueHeader = 'Value',
  ...base
}: DotStripProps) {
  const size = useChartSize(base.width, base.height);
  const axisWidth = yTicks?.length
    ? Math.max(...yTicks.map((tick) => String(tick).length)) * chartLayout.labelSize +
      chartLayout.plotInset
    : 0;
  const width = Math.max(1, size.width - axisWidth - 2 * chartLayout.plotInset);
  const height = Math.max(1, size.height - 2 * chartLayout.plotInset);
  const maximum = scaleMaximum([...points.map((point) => point.value), ask?.value ?? 0], max);
  return (
    <ChartFrame
      {...base}
      onLayout={size.onLayout}
      rows={pointTableRows(points)}
      headers={[valueHeader, 'State']}
    >
      <AskLabel ask={ask} />
      <Plot width={size.width} height={size.height}>
        <YAxisTicks ticks={yTicks} axisWidth={axisWidth} height={height} maximum={maximum} />
        <G testID="dot-strip-marks" x={axisWidth + chartLayout.plotInset} y={chartLayout.plotInset}>
          <Line
            x1={0}
            x2={width}
            y1={height}
            y2={height}
            stroke={surface.hairline}
            strokeWidth={chartLayout.hairlineWidth}
          />
          <AskLine ask={ask} width={width} height={height} max={maximum} />
          <DotMarks points={points} width={width} height={height} max={maximum} />
        </G>
      </Plot>
      <AxisLabels
        first={points[0]?.label}
        last={points.length > 1 ? points.at(-1)?.label : undefined}
      />
    </ChartFrame>
  );
}
