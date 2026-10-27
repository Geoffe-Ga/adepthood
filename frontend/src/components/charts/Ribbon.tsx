import React from 'react';
import { Circle, G, Line, Rect } from 'react-native-svg';

import { ChartFrame, ChartLegend, useChartSize } from './ChartFrame';
import { positive, ribbonGeometry } from './geometry';
import { Plot } from './Plot';
import type { ChartBaseProps, ChartTableRow, RibbonBlock } from './types';

import { accent, chartLayout } from '@/design/tokens';

export interface RibbonMarker {
  week: number;
  label: string;
}
export interface RibbonProps extends ChartBaseProps {
  blocks: readonly RibbonBlock[];
  currentWeek?: number;
  markers?: readonly RibbonMarker[];
  secondaryBlocks?: readonly RibbonBlock[];
}

export const ribbonTableRows = (blocks: readonly RibbonBlock[]): ChartTableRow[] =>
  blocks.map((block) => ({ label: block.label, values: [block.weeks] }));

function RibbonBlocks({
  blocks,
  width,
  height,
}: {
  blocks: readonly RibbonBlock[];
  width: number;
  height: number;
}) {
  return (
    <>
      {ribbonGeometry(blocks, width).map((block, index) => (
        <Rect
          key={index}
          testID={`ribbon-block-${index}`}
          x={block.x}
          y={0}
          width={block.width}
          height={height}
          fill={blocks[index]!.color}
        />
      ))}
    </>
  );
}

function RibbonMarks({
  currentWeek,
  markers,
  weeks,
  width,
}: {
  currentWeek?: number;
  markers: readonly RibbonMarker[];
  weeks: number;
  width: number;
}) {
  const x = (week: number) => Math.max(0, Math.min(1, (week - 1) / Math.max(1, weeks))) * width;
  return (
    <>
      {currentWeek === undefined ? null : (
        <Line
          testID="ribbon-here"
          x1={x(currentWeek)}
          x2={x(currentWeek)}
          y1={0}
          y2={chartLayout.ribbonHeight + chartLayout.plotInset}
          stroke={accent.primary}
          strokeWidth={chartLayout.lineWidth}
        />
      )}
      {markers.map((marker, index) => (
        <Circle
          key={index}
          cx={x(marker.week)}
          cy={chartLayout.ribbonHeight + chartLayout.plotInset}
          r={chartLayout.dotRadius}
          fill={accent.primary}
        />
      ))}
    </>
  );
}

export function Ribbon({
  blocks,
  currentWeek,
  markers = [],
  secondaryBlocks = [],
  ...base
}: RibbonProps) {
  const size = useChartSize(base.width, base.height);
  const width = Math.max(1, size.width - 2 * chartLayout.plotInset);
  const weeks = blocks.reduce((sum, block) => sum + positive(block.weeks), 0);
  const height = chartLayout.ribbonHeight + chartLayout.axisSpace;
  const rows = [
    ...ribbonTableRows(blocks),
    ...markers.map((marker) => ({ label: marker.label, values: [marker.week] })),
    ...(currentWeek === undefined ? [] : [{ label: 'You are here', values: [currentWeek] }]),
    ...ribbonTableRows(secondaryBlocks),
  ];
  return (
    <ChartFrame {...base} onLayout={size.onLayout} rows={rows} headers={['Weeks / week']}>
      <Plot width={size.width} height={height}>
        <G x={chartLayout.plotInset}>
          <RibbonBlocks blocks={blocks} width={width} height={chartLayout.ribbonHeight} />
          <RibbonMarks currentWeek={currentWeek} markers={markers} weeks={weeks} width={width} />
          <G y={height - chartLayout.secondaryRibbonHeight}>
            <RibbonBlocks
              blocks={secondaryBlocks}
              width={width}
              height={chartLayout.secondaryRibbonHeight}
            />
          </G>
        </G>
      </Plot>
      <ChartLegend items={[...blocks, ...secondaryBlocks]} />
      <ChartLegend
        items={markers.map((marker) => ({ label: marker.label, color: accent.primary }))}
      />
    </ChartFrame>
  );
}
