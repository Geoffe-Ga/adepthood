/**
 * Numbered habit markers under a pass ribbon (#3727): each habit's program
 * number on the week it was unlocked, a ring when it is locked again, stacked
 * in lanes so none overlap, and reachable by touch, hover and keyboard.
 */
import React, { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Circle, G, Text as SvgText } from 'react-native-svg';

import { chartStyles } from './chartStyles';
import { markerLanes, type MarkerSlot } from './geometry';
import type { ChartTableRow } from './types';

import { accent, chartLayout, fonts, ink, SPACING } from '@/design/tokens';

export interface RibbonMarker {
  week: number;
  label: string;
  /** A numbered badge — the habit's program number — instead of a plain dot. */
  number?: number;
  /** Drawn as a ring: the habit is locked again. */
  hollow?: boolean;
  /** The unlock day as written, e.g. `20 Jul`. */
  unlocked?: string;
  /** A closing clause for the readout and the table, e.g. `locked now`. */
  note?: string;
}

/** Centres a digit on its badge's middle, whatever the font's metrics. */
const CENTRED_BASELINE = '0.35em';
/** The number is the badge's whole content, so it is set a weight up. */
const BADGE_WEIGHT = '600';
const LANE_PITCH = 2 * chartLayout.markerRadius + chartLayout.gap;

export const isNumbered = (markers: readonly RibbonMarker[]): boolean =>
  markers.some((marker) => marker.number !== undefined);

/** Where lane `lane`'s badges sit, below the ribbon. */
export const laneY = (lane: number): number =>
  chartLayout.ribbonHeight +
  chartLayout.markerOffset +
  chartLayout.markerRadius +
  lane * LANE_PITCH;

/** The plot's height: the ribbon and every lane in use. */
export const numberedHeight = (lanes: number): number =>
  chartLayout.ribbonHeight + chartLayout.markerOffset + Math.max(1, lanes) * LANE_PITCH;

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** `Habit 3 · Meditation · unlocked 20 Jul, week 8`, as hover, touch and keyboard read it. */
export function markerDetail(marker: RibbonMarker): string {
  const clauses = [
    marker.unlocked ? `unlocked ${marker.unlocked}` : null,
    `week ${marker.week}`,
    marker.note ?? null,
  ].filter((clause): clause is string => clause !== null);
  return `${marker.label} · ${clauses.join(', ')}`;
}

/**
 * The table twin's cells for one marker: its week first, under the table's
 * one header (arc position), then the unlock day and any lock, each of which
 * names itself.
 */
export const markerCells = (marker: RibbonMarker, week: string): ChartTableRow['values'] => [
  week,
  ...(marker.unlocked ? [`Unlocked ${marker.unlocked}`] : []),
  ...(marker.note ? [capitalise(marker.note)] : []),
];

export function useMarkerLayout(markers: readonly RibbonMarker[], weeks: number, width: number) {
  return markerLanes(
    markers.map((marker) => marker.week),
    weeks,
    width,
  );
}

type Layout = ReturnType<typeof useMarkerLayout>;

function webInspection(
  selectAt: (_x: number, _y: number) => void,
  move: (_offset: number) => void,
  setIndex: (_index: number) => void,
  count: number,
) {
  if (Platform.OS !== 'web') return {};
  return {
    onMouseMove: (event: MouseEvent<HTMLElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      selectAt(event.clientX - bounds.left, event.clientY - bounds.top);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') setIndex(0);
      else if (event.key === 'End') setIndex(count - 1);
      else move(event.key === 'ArrowRight' ? 1 : -1);
    },
  };
}

/** The marker nearest a point on the plot, in the plot's own coordinates. */
function nearest(slots: readonly MarkerSlot[], x: number, y: number): number | null {
  let best: { index: number; distance: number } | null = null;
  for (const slot of slots) {
    const distance = Math.hypot(slot.x - x, laneY(slot.lane) - y);
    if (best === null || distance < best.distance) best = { index: slot.index, distance };
  }
  return best?.index ?? null;
}

/**
 * Which marker is being read. Travel follows the list's own order (week, then
 * number), so a marker that overflowed its lane is still reached.
 */
export function useMarkerInspection(markers: readonly RibbonMarker[], layout: Layout) {
  const [selected, setSelected] = useState<number | null>(null);
  const last = markers.length - 1;
  const selectAt = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const index = nearest(layout.slots, x - chartLayout.plotInset, y);
    if (index !== null) setSelected(index);
  };
  const move = (offset: number) =>
    setSelected(selected === null ? 0 : Math.max(0, Math.min(last, selected + offset)));
  const marker = selected === null ? undefined : markers[selected];
  return {
    selected,
    detail: marker ? markerDetail(marker) : null,
    selectAt,
    move,
    web: webInspection(selectAt, move, setSelected, markers.length),
  };
}

type Inspection = ReturnType<typeof useMarkerInspection>;

function Badge({
  marker,
  slot,
  selected,
}: {
  marker: RibbonMarker;
  slot: MarkerSlot;
  selected: boolean;
}) {
  const y = laneY(slot.lane);
  const hollow = marker.hollow === true;
  return (
    <G>
      {selected ? (
        <Circle
          cx={slot.x}
          cy={y}
          r={chartLayout.markerRadius + chartLayout.gap}
          fill="none"
          stroke={accent.strong}
          strokeWidth={chartLayout.lineWidth}
        />
      ) : null}
      <Circle
        testID={`ribbon-marker-${slot.index}`}
        cx={slot.x}
        cy={y}
        r={chartLayout.markerRadius - chartLayout.hairlineWidth}
        fill={hollow ? 'none' : accent.primary}
        stroke={accent.primary}
        strokeWidth={chartLayout.lineWidth}
      />
      <SvgText
        x={slot.x}
        y={y}
        dy={CENTRED_BASELINE}
        textAnchor="middle"
        fontFamily={fonts.sans}
        fontSize={chartLayout.markerLabelSize}
        fontWeight={BADGE_WEIGHT}
        fill={hollow ? accent.primary : accent.onPrimary}
      >
        {String(marker.number ?? '')}
      </SvgText>
    </G>
  );
}

/** Every badge that found a lane; the rest are counted beneath the plot. */
export function NumberedMarks({
  markers,
  layout,
  selected,
}: {
  markers: readonly RibbonMarker[];
  layout: Layout;
  selected: number | null;
}) {
  return (
    <>
      {layout.slots.map((slot) => (
        <Badge
          key={slot.index}
          marker={markers[slot.index]!}
          slot={slot}
          selected={slot.index === selected}
        />
      ))}
    </>
  );
}

export function MarkerInspector({
  summary,
  testID,
  inspection,
  children,
}: {
  summary: string;
  testID?: string;
  inspection: Inspection;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      testID={`${testID}-inspect`}
      accessibilityRole="adjustable"
      accessibilityLabel={summary}
      accessibilityHint="Tap a habit's number to read it. Use left and right arrow keys to move between habits."
      accessibilityValue={inspection.detail ? { text: inspection.detail } : undefined}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) =>
        inspection.move(event.nativeEvent.actionName === 'increment' ? 1 : -1)
      }
      onPress={(event) =>
        inspection.selectAt(event.nativeEvent.locationX, event.nativeEvent.locationY)
      }
      {...inspection.web}
    >
      {children}
    </Pressable>
  );
}

/** `2 more in week 8, listed in the table.` — one sentence per crowded week. */
export function overflowLine(markers: readonly RibbonMarker[], overflow: readonly number[]) {
  const byWeek = new Map<number, number>();
  for (const index of overflow) {
    const week = markers[index]!.week;
    byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
  }
  return [...byWeek]
    .map(([week, count]) => `${count} more in week ${week}, listed in the table.`)
    .join(' ');
}

/** The marker being read, and a count of any that did not fit. */
export function MarkerReadout({
  markers,
  layout,
  inspection,
  testID,
}: {
  markers: readonly RibbonMarker[];
  layout: Layout;
  inspection: Inspection;
  testID?: string;
}) {
  const overflow = overflowLine(markers, layout.overflow);
  if (!inspection.detail && !overflow) return null;
  return (
    <View testID={`${testID}-notes`} style={styles.notes}>
      {inspection.detail ? (
        <Text testID={`${testID}-value`} style={[chartStyles.tick, styles.detail]}>
          {inspection.detail}
        </Text>
      ) : null}
      {overflow ? <Text style={chartStyles.caption}>{overflow}</Text> : null}
    </View>
  );
}

/**
 * The unfilled remainder of the arc, so rows stay aligned week for week:
 * an outline only, dashed, so it never reads as the pale Clear block.
 */
export const TRACK = {
  fill: 'none',
  stroke: ink.muted,
  dash: `${chartLayout.trackDash} ${chartLayout.trackDash}`,
} as const;

const styles = StyleSheet.create({
  detail: { color: ink.primary },
  // The frame's own rhythm, and the track's left edge (#3727).
  notes: { gap: SPACING.sm, marginTop: SPACING.sm, paddingLeft: chartLayout.plotInset },
});
