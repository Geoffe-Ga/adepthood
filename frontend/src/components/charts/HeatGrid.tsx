import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Rect, Text as SvgText } from 'react-native-svg';

import { ChartFrame, ChartLegend, useChartSize } from './ChartFrame';
import { chartStyles } from './chartStyles';
import { Plot } from './Plot';
import type { ChartBaseProps, ChartTableRow, LabelledSwatch } from './types';

import { chart, chartLayout, fonts, ink } from '@/design/tokens';

export interface HeatCell {
  label: string;
  level: 0 | 1 | 2 | 3;
  hollow?: boolean;
}

export interface HeatStageMarker extends LabelledSwatch {
  columnIndex: number;
}

export interface HeatGridProps extends ChartBaseProps {
  weeks: readonly (readonly HeatCell[])[];
  markers?: readonly HeatStageMarker[];
  rowLabels?: readonly string[];
  columnLabels?: readonly string[];
}

export const heatTableRows = (weeks: readonly (readonly HeatCell[])[]): ChartTableRow[] =>
  weeks.flatMap((week) =>
    week.map((cell) => ({
      label: cell.label,
      values: [cell.level, ...(cell.hollow ? ['Logged, under Low'] : [])],
    })),
  );
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function HeatRowLabels({
  rowLabels,
  cellHeight,
}: {
  rowLabels: readonly string[];
  cellHeight: number;
}) {
  return (
    <>
      {rowLabels.map((label, row) => (
        <SvgText
          key={row}
          x={0}
          y={chartLayout.axisSpace + (row + 0.75) * cellHeight}
          fontFamily={fonts.sans}
          fontSize={chartLayout.labelSize}
          fill={ink.muted}
        >
          {label}
        </SvgText>
      ))}
    </>
  );
}

function HeatWeek({
  week,
  column,
  cellWidth,
  cellHeight,
  setTooltip,
}: {
  week: readonly HeatCell[];
  column: number;
  cellWidth: number;
  cellHeight: number;
  setTooltip: (_label: string) => void;
}) {
  return (
    <>
      {week.map((cell, row) => (
        <Rect
          key={row}
          testID={`heat-grid-cell-${column}-${row}`}
          x={chartLayout.axisSpace + column * cellWidth}
          y={chartLayout.axisSpace + row * cellHeight}
          width={Math.max(0, cellWidth - chartLayout.gap)}
          height={Math.max(0, cellHeight - chartLayout.gap)}
          rx={chartLayout.gap}
          fill={cell.hollow ? 'none' : chart.heat[cell.level === 0 ? 0 : cell.level + 1]}
          stroke={cell.hollow ? chart.tier[0] : 'none'}
          strokeWidth={chartLayout.hairlineWidth}
          onPress={() => setTooltip(cell.label)}
          onLongPress={() => setTooltip(cell.label)}
        />
      ))}
    </>
  );
}

function HeatMarks({
  weeks,
  markers,
  cellWidth,
  cellHeight,
  setTooltip,
  rowLabels,
}: {
  weeks: HeatGridProps['weeks'];
  markers: readonly HeatStageMarker[];
  cellWidth: number;
  cellHeight: number;
  setTooltip: (_label: string) => void;
  rowLabels: readonly string[];
}) {
  return (
    <>
      <HeatRowLabels rowLabels={rowLabels} cellHeight={cellHeight} />
      {markers.map((marker, index) => (
        <Rect
          key={index}
          x={chartLayout.axisSpace + marker.columnIndex * cellWidth}
          y={chartLayout.plotInset}
          width={Math.max(0, cellWidth - chartLayout.gap)}
          height={chartLayout.swatchSize}
          fill={marker.color}
        />
      ))}
      {weeks.map((week, column) => (
        <HeatWeek
          key={column}
          week={week}
          column={column}
          cellWidth={cellWidth}
          cellHeight={cellHeight}
          setTooltip={setTooltip}
        />
      ))}
    </>
  );
}

function HeatFooter({
  markers,
  columnLabels,
  gridWidth,
  tooltip,
}: {
  markers: readonly HeatStageMarker[];
  columnLabels: readonly string[];
  gridWidth: number;
  tooltip: string | null;
}) {
  return (
    <>
      <ChartLegend items={markers} />
      <View style={[chartStyles.axis, { marginLeft: chartLayout.axisSpace, width: gridWidth }]}>
        {columnLabels.map((label, index) => (
          <Text key={index} style={chartStyles.caption}>
            {label}
          </Text>
        ))}
      </View>
      {tooltip ? (
        <View style={chartStyles.tooltip}>
          <Text accessibilityLiveRegion="polite" style={chartStyles.caption}>
            {tooltip}
          </Text>
        </View>
      ) : null}
    </>
  );
}

export function HeatGrid({
  weeks,
  markers = [],
  rowLabels = WEEKDAYS,
  columnLabels = [],
  ...base
}: HeatGridProps) {
  const size = useChartSize(base.width, base.height);
  const [tooltip, setTooltip] = useState<string | null>(null);
  const cellWidth = Math.max(
    0,
    Math.min(
      columnLabels.length > 0 ? size.width : chartLayout.columnMaxWidth,
      (size.width - chartLayout.axisSpace) / Math.max(1, weeks.length),
    ),
  );
  const cellHeight = Math.max(
    0,
    (size.height - chartLayout.axisSpace) / Math.max(1, rowLabels.length),
  );
  return (
    <ChartFrame
      {...base}
      onLayout={size.onLayout}
      rows={heatTableRows(weeks)}
      headers={['Tier level', 'State']}
    >
      <Plot width={size.width} height={size.height}>
        <HeatMarks
          weeks={weeks}
          markers={markers}
          rowLabels={rowLabels}
          cellWidth={cellWidth}
          cellHeight={cellHeight}
          setTooltip={setTooltip}
        />
      </Plot>
      <HeatFooter
        markers={markers}
        columnLabels={columnLabels}
        gridWidth={cellWidth * weeks.length}
        tooltip={tooltip}
      />
    </ChartFrame>
  );
}
