import React from 'react';
import { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { ChartFrame, ChartLegend, useChartSize } from './ChartFrame';
import { pointTableRows } from './DotStrip';
import { axisTickLabels, dotGeometry, pointX, scaleMaximum } from './geometry';
import { Plot } from './Plot';
import type { ChartBaseProps, ChartPoint, LabelledSwatch } from './types';

import { accent, chartLayout, fonts, ink, surface } from '@/design/tokens';

export interface WaveTick {
  index: number;
  label: string;
}
export interface WaveSwatch extends LabelledSwatch {
  index: number;
}
export interface WaveProps extends ChartBaseProps {
  points: readonly ChartPoint[];
  max?: number;
  monthTicks?: readonly WaveTick[];
  swatches?: readonly WaveSwatch[];
}

function WaveShape({
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
  const positions = dotGeometry(points, width, height, max);
  const line = positions
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
  const last = positions.at(-1);
  if (!last) return null;
  const first = positions[0]!;
  return (
    <>
      <Path
        testID="wave-area"
        d={`${line} L ${last.x} ${height} L ${first.x} ${height} Z`}
        fill={accent.primary}
        fillOpacity={0.1}
      />
      <Path
        testID="wave-line"
        d={line}
        fill="none"
        stroke={accent.primary}
        strokeWidth={chartLayout.lineWidth}
      />
      <Circle
        cx={last.x}
        cy={last.y}
        r={chartLayout.dotRadius}
        fill={accent.primary}
        stroke={surface.canvas}
        strokeWidth={chartLayout.lineWidth}
      />
    </>
  );
}

function MonthTicks({
  ticks,
  count,
  width,
  height,
}: {
  ticks: readonly WaveTick[];
  count: number;
  width: number;
  height: number;
}) {
  return (
    <>
      {ticks.map((tick, index) => (
        <Line
          key={index}
          x1={pointX(tick.index, count, width)}
          x2={pointX(tick.index, count, width)}
          y1={height}
          y2={height + chartLayout.gap}
          stroke={surface.hairline}
          strokeWidth={chartLayout.hairlineWidth}
        />
      ))}
      {axisTickLabels(ticks, count, width).map((tick) => (
        <SvgText
          key={tick.index}
          x={tick.x}
          y={height + chartLayout.axisSpace}
          fontSize={chartLayout.labelSize}
          fontFamily={fonts.sans}
          fontFeatureSettings="'tnum'"
          fill={ink.muted}
          textAnchor={tick.anchor}
        >
          {tick.label}
        </SvgText>
      ))}
    </>
  );
}

function WaveTicks({
  ticks,
  swatches,
  count,
  width,
  height,
}: {
  ticks: readonly WaveTick[];
  swatches: readonly WaveSwatch[];
  count: number;
  width: number;
  height: number;
}) {
  return (
    <>
      <MonthTicks ticks={ticks} count={count} width={width} height={height} />
      {swatches.map((swatch, index) => (
        <Rect
          key={index}
          x={Math.max(0, pointX(swatch.index, count, width) - chartLayout.gap)}
          y={height + chartLayout.gap}
          width={chartLayout.gap * 2}
          height={chartLayout.swatchSize}
          fill={swatch.color}
        />
      ))}
    </>
  );
}

export function Wave({ points, max, monthTicks = [], swatches = [], ...base }: WaveProps) {
  const size = useChartSize(base.width, base.height);
  const width = Math.max(1, size.width - 2 * chartLayout.plotInset);
  const height = Math.max(1, size.height - chartLayout.axisSpace - 2 * chartLayout.plotInset);
  const maximum = scaleMaximum(
    points.map((point) => point.value),
    max,
  );
  return (
    <ChartFrame
      {...base}
      onLayout={size.onLayout}
      rows={pointTableRows(points)}
      headers={['Value', 'State']}
    >
      <Plot width={size.width} height={size.height}>
        <G x={chartLayout.plotInset} y={chartLayout.plotInset}>
          <Line
            x1={0}
            x2={width}
            y1={height}
            y2={height}
            stroke={surface.hairline}
            strokeWidth={chartLayout.hairlineWidth}
          />
          <WaveShape points={points} width={width} height={height} max={maximum} />
          <WaveTicks
            ticks={monthTicks}
            swatches={swatches}
            count={points.length}
            width={width}
            height={height}
          />
        </G>
      </Plot>
      <ChartLegend items={swatches} />
    </ChartFrame>
  );
}
