import React from 'react';
import { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { columnGeometry, columnPath, domainY, pointX } from './geometry';
import { Plot } from './Plot';
import type { ChartPoint } from './types';

import { chartLayout, fonts, ink, SPACING, surface } from '@/design/tokens';

/** Space for a signed value axis, independent of a phone's available width. */
export const VALUE_AXIS_WIDTH = 48;
export const formatHistoryValue = (value: number): string =>
  new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 }).format(value);

interface HistoryPlotProps {
  points: readonly ChartPoint[];
  width: number;
  height: number;
  min: number;
  max: number;
  color: string;
  variant: 'line' | 'columns';
  selected: number | null;
}

function ValueAxis({
  min,
  max,
  width,
  height,
}: Pick<HistoryPlotProps, 'min' | 'max' | 'width' | 'height'>) {
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
            {formatHistoryValue(value)}
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

export function HistoryPlot(props: HistoryPlotProps) {
  const plot = {
    ...props,
    width: Math.max(1, props.width - VALUE_AXIS_WIDTH - chartLayout.plotInset),
    height: Math.max(1, props.height - 2 * chartLayout.plotInset),
  };
  return (
    <Plot width={props.width} height={props.height}>
      <G x={VALUE_AXIS_WIDTH} y={chartLayout.plotInset}>
        <ValueAxis {...plot} />
        <Series {...plot} />
        <Cursor {...plot} />
      </G>
    </Plot>
  );
}
