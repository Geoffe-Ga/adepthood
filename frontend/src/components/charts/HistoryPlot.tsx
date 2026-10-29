import React from 'react';
import { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { columnGeometry, columnPath, domainY, pointX } from './geometry';
import { Plot } from './Plot';
import type { ChartPoint } from './types';

import { chartLayout, fonts, ink, SPACING, surface } from '@/design/tokens';

/** Space for a signed value axis, independent of a phone's available width. */
export const VALUE_AXIS_WIDTH = 48;
/** At or above this magnitude a figure is shown whole; below it, to one decimal. */
const WHOLE_FIGURE_FROM = 10;

/**
 * A figure a person can read at a glance: whole from ten, one decimal below.
 * Six decimals of a 7-day mean (`1.285714`) is noise, and in the axis gutter
 * its leading digits were clipped into a nonsense `285714`.
 */
export const formatHistoryValue = (value: number): string =>
  new Intl.NumberFormat('en-GB', {
    maximumFractionDigits: Math.abs(value) >= WHOLE_FIGURE_FROM ? 0 : 1,
  }).format(value);

interface HistoryPlotProps {
  points: readonly ChartPoint[];
  width: number;
  height: number;
  min: number;
  max: number;
  color: string;
  variant: 'line' | 'columns';
  selected: number | null;
  /** Gutter for the value axis; 0 draws a bare sparkline with only its baseline. */
  axisWidth: number;
  format: (_value: number) => string;
}

function ValueAxis({
  min,
  max,
  width,
  height,
  format,
}: Pick<HistoryPlotProps, 'min' | 'max' | 'width' | 'height' | 'format'>) {
  return (
    <>
      {[...new Set([max, 0, min])].map((value) => (
        <G key={value}>
          <Line
            x1={0}
            x2={width}
            y1={domainY(value, min, max, height)}
            y2={domainY(value, min, max, height)}
            stroke={surface.hairline}
            strokeWidth={chartLayout.hairlineWidth}
          />
          <SvgText
            x={-SPACING.sm}
            y={domainY(value, min, max, height)}
            alignmentBaseline="middle"
            textAnchor="end"
            fontSize={chartLayout.labelSize}
            fontFamily={fonts.sans}
            fill={ink.muted}
          >
            {format(value)}
          </SvgText>
        </G>
      ))}
    </>
  );
}

function Series({ points, width, height, min, max, color, variant }: HistoryPlotProps) {
  if (points.length === 0) return null;
  if (variant === 'columns') {
    return (
      <>
        {columnGeometry(
          points.map((item) => ({ label: item.label, segments: [item.value] })),
          width,
          height,
          max,
          min,
        ).map((segments, index) => (
          <Path key={index} d={columnPath(segments[0]!)} fill={color} />
        ))}
      </>
    );
  }
  if (points.length === 1)
    return (
      <Circle
        cx={pointX(0, points.length, width)}
        cy={domainY(points[0]!.value, min, max, height)}
        r={chartLayout.dotRadius}
        fill={color}
      />
    );
  return (
    <Path
      testID="history-line"
      d={points
        .map(
          (item, index) =>
            `${index === 0 ? 'M' : 'L'} ${pointX(index, points.length, width)} ${domainY(item.value, min, max, height)}`,
        )
        .join(' ')}
      fill="none"
      stroke={color}
      strokeWidth={chartLayout.lineWidth}
    />
  );
}

function Cursor({ points, width, height, min, max, color, variant, selected }: HistoryPlotProps) {
  const point = selected === null ? undefined : points[selected];
  if (!point || selected === null) return null;
  const x =
    variant === 'columns'
      ? ((selected + 0.5) / points.length) * width
      : pointX(selected, points.length, width);
  return (
    <>
      <Line
        x1={x}
        x2={x}
        y1={0}
        y2={height}
        stroke={ink.muted}
        strokeWidth={chartLayout.hairlineWidth}
      />
      <Circle
        cx={x}
        cy={domainY(point.value, min, max, height)}
        r={chartLayout.dotRadius}
        fill={color}
        stroke={ink.primary}
        strokeWidth={chartLayout.hairlineWidth}
      />
    </>
  );
}

function Baseline({
  width,
  height,
  min,
  max,
}: Pick<HistoryPlotProps, 'width' | 'height' | 'min' | 'max'>) {
  const y = domainY(0, min, max, height);
  return (
    <Line
      x1={0}
      x2={width}
      y1={y}
      y2={y}
      stroke={surface.hairline}
      strokeWidth={chartLayout.hairlineWidth}
    />
  );
}

/** Horizontal room the plot leaves for its axis gutter and right inset. */
export const plotExtent = (width: number, axisWidth: number): number =>
  Math.max(1, width - axisWidth - chartLayout.plotInset);

export function HistoryPlot(props: HistoryPlotProps) {
  const plot = {
    ...props,
    width: plotExtent(props.width, props.axisWidth),
    height: Math.max(1, props.height - 2 * chartLayout.plotInset),
  };
  return (
    <Plot width={props.width} height={props.height}>
      <G x={props.axisWidth} y={chartLayout.plotInset}>
        {props.axisWidth > 0 ? <ValueAxis {...plot} /> : <Baseline {...plot} />}
        <Series {...plot} />
        <Cursor {...plot} />
      </G>
    </Plot>
  );
}
