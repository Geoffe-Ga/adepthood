import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Circle, G, Line, Rect } from 'react-native-svg';

import { ChartFrame, useChartSize } from './ChartFrame';
import { chartStyles } from './chartStyles';
import { positive, ribbonGeometry, weekCenter } from './geometry';
import { Plot } from './Plot';
import {
  isNumbered,
  MarkerInspector,
  markerCells,
  MarkerReadout,
  NumberedMarks,
  numberedHeight,
  TRACK,
  useMarkerInspection,
  useMarkerLayout,
  type RibbonMarker,
} from './RibbonPassMarks';
import type { ChartBaseProps, ChartTableRow, RibbonBlock } from './types';

import { accent, chartLayout, SPACING, surface } from '@/design/tokens';

export type { RibbonMarker } from './RibbonPassMarks';
export interface RibbonProps extends ChartBaseProps {
  blocks: readonly RibbonBlock[];
  currentWeek?: number;
  /**
   * Weeks drawn in stage colour, from the first; the rest of the arc is an
   * unfilled track so stacked pass rows stay aligned week for week (#3727).
   * Omitted, the whole arc is drawn.
   */
  drawnWeeks?: number;
  markers?: readonly RibbonMarker[];
  secondaryBlocks?: readonly RibbonBlock[];
  showKey?: boolean;
  /** Shown on the frame's header row beside the table toggle. */
  title?: string;
}

/**
 * Below this a block's visible width is rounding, not drawing: a block that
 * starts exactly where the drawn weeks end must not leave a stroked sliver.
 */
const ROUNDING_WIDTH = 1e-6;

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
  drawnWidth = width,
}: {
  blocks: readonly RibbonBlock[];
  width: number;
  height: number;
  /** Blocks are cut off here; a block wholly past it is not drawn. */
  drawnWidth?: number;
}) {
  return (
    <>
      {ribbonGeometry(blocks, width).flatMap((block, index) => {
        const visible = Math.min(block.width, drawnWidth - block.x);
        return visible > ROUNDING_WIDTH
          ? [
              <Rect
                key={index}
                testID={`ribbon-block-${index}`}
                x={block.x}
                y={0}
                width={visible}
                height={height}
                fill={blocks[index]!.color}
                stroke={surface.hairline}
                strokeWidth={chartLayout.hairlineWidth}
              />,
            ]
          : [];
      })}
    </>
  );
}

/** The arc's unfilled remainder, under any blocks drawn over its start. */
function RibbonTrack({ width }: { width: number }) {
  return (
    <Rect
      testID="ribbon-track"
      x={0}
      y={0}
      width={width}
      height={chartLayout.ribbonHeight}
      fill={TRACK.fill}
      stroke={TRACK.stroke}
      strokeWidth={chartLayout.hairlineWidth}
      strokeDasharray={TRACK.dash}
    />
  );
}

/**
 * Where you are. On a pass row it stands on the middle of its week, where that
 * week's numbered badges sit, and stops short of them; on the plain arc it
 * marks the week's start and reaches down to the birth dots.
 */
function HereLine({ x, passRow }: { x: number; passRow: boolean }) {
  const y2 = chartLayout.ribbonHeight + (passRow ? 0 : chartLayout.plotInset);
  return (
    <>
      {passRow ? (
        <Line
          testID="ribbon-here-halo"
          x1={x}
          x2={x}
          y1={0}
          y2={y2}
          stroke={surface.canvas}
          strokeWidth={chartLayout.haloWidth}
        />
      ) : null}
      <Line
        testID="ribbon-here"
        x1={x}
        x2={x}
        y1={0}
        y2={y2}
        stroke={accent.primary}
        strokeWidth={chartLayout.lineWidth}
      />
    </>
  );
}

function RibbonMarks({
  currentWeek,
  markers,
  weeks,
  width,
  passRow,
}: {
  currentWeek?: number;
  markers: readonly RibbonMarker[];
  weeks: number;
  width: number;
  /**
   * A pass row (#3727) measures every mark from the middle of its week, stops
   * the you-are-here line at the track and haloes it.
   */
  passRow: boolean;
}) {
  const x = (week: number) => Math.max(0, Math.min(1, (week - 1) / Math.max(1, weeks))) * width;
  const numbered = isNumbered(markers);
  const pass = passRow || numbered;
  return (
    <>
      {currentWeek === undefined ? null : (
        <HereLine
          x={pass ? weekCenter(currentWeek, weeks, width) : x(currentWeek)}
          passRow={pass}
        />
      )}
      {numbered
        ? null
        : markers.map((marker, index) => (
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
  values: markerCells(marker, weekPosition(marker.week)),
});

const hereRows = (currentWeek?: number): ChartTableRow[] =>
  currentWeek === undefined ? [] : [{ label: 'You are here', values: [weekPosition(currentWeek)] }];

interface RibbonPlotProps {
  blocks: readonly RibbonBlock[];
  secondaryBlocks: readonly RibbonBlock[];
  markers: readonly RibbonMarker[];
  currentWeek?: number;
  drawnWeeks?: number;
  weeks: number;
  width: number;
  plotWidth: number;
  height: number;
  marks?: React.ReactNode;
}

function RibbonPlot(props: RibbonPlotProps) {
  const { blocks, width, weeks, drawnWeeks, height } = props;
  const limited = drawnWeeks !== undefined && drawnWeeks < weeks;
  return (
    <Plot width={props.plotWidth} height={height}>
      <G x={chartLayout.plotInset}>
        {limited ? <RibbonTrack width={width} /> : null}
        <RibbonBlocks
          blocks={blocks}
          width={width}
          height={chartLayout.ribbonHeight}
          drawnWidth={limited ? (Math.max(0, drawnWeeks) / Math.max(1, weeks)) * width : width}
        />
        <RibbonMarks
          currentWeek={props.currentWeek}
          markers={props.markers}
          weeks={weeks}
          width={width}
          passRow={drawnWeeks !== undefined}
        />
        {props.marks}
        <G y={height - chartLayout.secondaryRibbonHeight}>
          <RibbonBlocks
            blocks={props.secondaryBlocks}
            width={width}
            height={chartLayout.secondaryRibbonHeight}
          />
        </G>
      </G>
    </Plot>
  );
}

/** A pass row's ribbon with its numbered habits, inspectable by touch, hover and keys. */
function NumberedRibbon({
  plot,
  summary,
  testID,
}: {
  plot: Omit<RibbonPlotProps, 'height' | 'marks'>;
  summary: string;
  testID?: string;
}) {
  const layout = useMarkerLayout(plot.markers, plot.weeks, plot.width);
  const inspection = useMarkerInspection(plot.markers, layout);
  return (
    <>
      <MarkerInspector summary={summary} testID={testID} inspection={inspection}>
        <RibbonPlot
          {...plot}
          height={numberedHeight(layout.lanes)}
          marks={
            <NumberedMarks markers={plot.markers} layout={layout} selected={inspection.selected} />
          }
        />
      </MarkerInspector>
      <MarkerReadout
        markers={plot.markers}
        layout={layout}
        inspection={inspection}
        testID={testID}
      />
    </>
  );
}

/** A pass row's table leads with its habits; the plain arc leads with its stages. */
const tableRows = (
  stageRows: readonly ChartTableRow[],
  markerRows: readonly ChartTableRow[],
  currentWeek: number | undefined,
  numbered: boolean,
): ChartTableRow[] =>
  numbered
    ? [...markerRows, ...hereRows(currentWeek), ...stageRows]
    : [...stageRows, ...markerRows, ...hereRows(currentWeek)];

/** The plain arc, or a pass row with numbered habits when its markers carry numbers. */
function RibbonBody({
  plot,
  summary,
  testID,
}: {
  plot: Omit<RibbonPlotProps, 'height' | 'marks'>;
  summary: string;
  testID?: string;
}) {
  return isNumbered(plot.markers) ? (
    <NumberedRibbon plot={plot} summary={summary} testID={testID} />
  ) : (
    <RibbonPlot {...plot} height={chartLayout.ribbonHeight + chartLayout.axisSpace} />
  );
}

export function Ribbon({
  blocks,
  currentWeek,
  drawnWeeks,
  markers = [],
  secondaryBlocks = [],
  showKey = true,
  title,
  ...base
}: RibbonProps) {
  const size = useChartSize(base.width, base.height);
  const width = Math.max(1, size.width - 2 * chartLayout.plotInset);
  const weeks = blocks.reduce((sum, block) => sum + positive(block.weeks), 0);
  const stageRows = [...ribbonTableRows(blocks), ...ribbonTableRows(secondaryBlocks)];
  const markerRows = markers.map(markerRow);
  const plot = { blocks, secondaryBlocks, markers, currentWeek, drawnWeeks, weeks, width };
  return (
    <ChartFrame
      {...base}
      title={title}
      onLayout={size.onLayout}
      interactive={isNumbered(markers)}
      // A pass row's header starts where its track does (#3727).
      inset={drawnWeeks !== undefined || isNumbered(markers) ? chartLayout.plotInset : undefined}
      rows={tableRows(stageRows, markerRows, currentWeek, isNumbered(markers))}
      headers={['Arc position']}
    >
      <RibbonBody
        plot={{ ...plot, plotWidth: size.width }}
        summary={base.summary}
        testID={base.testID}
      />
      {showKey ? (
        <>
          <RibbonKey
            testID="ribbon-stage-key"
            rows={stageRows}
            blocks={[...blocks, ...secondaryBlocks]}
          />
          <RibbonKey testID="ribbon-birth-key" rows={markerRows} />
        </>
      ) : null}
    </ChartFrame>
  );
}

const styles = StyleSheet.create({
  key: { gap: SPACING.sm },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  keyName: { flex: 1 },
});
