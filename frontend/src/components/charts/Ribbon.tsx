import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Circle, G, Line, Rect } from 'react-native-svg';

import { ChartFrame, useChartSize } from './ChartFrame';
import { chartStyles } from './chartStyles';
import { positive, ribbonGeometry } from './geometry';
import { Plot } from './Plot';
import type { ChartBaseProps, ChartTableRow, RibbonBlock } from './types';

import { accent, chartLayout, SPACING, surface } from '@/design/tokens';

export interface RibbonMarker {
  week: number;
  label: string;
}
export interface RibbonProps extends ChartBaseProps {
  blocks: readonly RibbonBlock[];
  currentWeek?: number;
  markers?: readonly RibbonMarker[];
  secondaryBlocks?: readonly RibbonBlock[];
  showKey?: boolean;
  /** Shown on the frame's header row beside the table toggle. */
  title?: string;
}

const weekPosition = (first: number, last = first): string =>
  first === last ? `Week ${first}` : `Weeks ${first}–${last}`;

/** Durations size the blocks; inclusive ranges tell the reader where they are. */
export function ribbonTableRows(blocks: readonly RibbonBlock[]): ChartTableRow[] {
  let first = 1;
  return blocks.map((block) => {
    const last = first + positive(block.weeks) - 1;
    const row = { label: block.label, values: [weekPosition(first, last)] };
    first = last + 1;
    return row;
  });
}

/** One name and its position per row, including when a long name wraps. */
function RibbonKey({
  rows,
  blocks = [],
  testID,
}: {
  rows: readonly ChartTableRow[];
  blocks?: readonly RibbonBlock[];
  testID: string;
}) {
  return (
    <View testID={testID} style={styles.key}>
      {rows.map((row, index) => (
        <View key={`${index}-${row.label}`} style={styles.keyRow}>
          {blocks[index] ? (
            <View style={[chartStyles.swatch, { backgroundColor: blocks[index].color }]} />
          ) : null}
          <Text style={[chartStyles.caption, styles.keyName]}>{row.label}</Text>
          <Text style={chartStyles.tick}>{row.values[0]}</Text>
        </View>
      ))}
    </View>
  );
}

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
          stroke={surface.hairline}
          strokeWidth={chartLayout.hairlineWidth}
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

const markerRow = (marker: RibbonMarker): ChartTableRow => ({
  label: marker.label,
  values: [weekPosition(marker.week)],
});

const hereRows = (currentWeek?: number): ChartTableRow[] =>
  currentWeek === undefined ? [] : [{ label: 'You are here', values: [weekPosition(currentWeek)] }];

export function Ribbon({
  blocks,
  currentWeek,
  markers = [],
  secondaryBlocks = [],
  showKey = true,
  title,
  ...base
}: RibbonProps) {
  const size = useChartSize(base.width, base.height);
  const width = Math.max(1, size.width - 2 * chartLayout.plotInset);
  const weeks = blocks.reduce((sum, block) => sum + positive(block.weeks), 0);
  const height = chartLayout.ribbonHeight + chartLayout.axisSpace;
  const stageRows = [...ribbonTableRows(blocks), ...ribbonTableRows(secondaryBlocks)];
  const markerRows = markers.map(markerRow);
  const rows = [...stageRows, ...markerRows, ...hereRows(currentWeek)];
  return (
    <ChartFrame
      {...base}
      title={title}
      onLayout={size.onLayout}
      rows={rows}
      headers={['Arc position']}
    >
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
      {showKey ? (
        <RibbonKey
          testID="ribbon-stage-key"
          rows={stageRows}
          blocks={[...blocks, ...secondaryBlocks]}
        />
      ) : null}
      {showKey ? <RibbonKey testID="ribbon-birth-key" rows={markerRows} /> : null}
    </ChartFrame>
  );
}

const styles = StyleSheet.create({
  key: { gap: SPACING.sm },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  keyName: { flex: 1 },
});
