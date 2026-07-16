/**
 * The Map header-drawer body: a compact legend of all ten stages rendered as
 * ``ScreenDrawer`` children (the panel supplies the scroll surface, so this maps
 * plain rows). Each row shows the stage's color swatch, its category, and — when
 * present — its Aspect; the current stage is marked, and a locked stage carries a
 * padlock plus its calendar unlock estimate. Tapping any row — locked or not —
 * glides the magnifier lens to that stage, opens its detail modal, and closes the
 * drawer.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';

import { SPACING, accent, ink, radius, surface, touchTarget, type } from '../../design/tokens';
import { useDaysUntilStage } from '../../store/useProgramProgression';

import { useJourneySummary } from './hooks/useJourneySummary';
import { unlockTimeline } from './journeyNarrative';
import { MAP_ROWS, STAGE_DISPLAY, type StageDisplay } from './mapLayout';
import { isStageUnlocked } from './services/stageService';
import { STAGE_COUNT, type StageData } from './stageData';
import { drawerStageLabel } from './stageLegend';

/** Glyph shown on a locked stage row. */
const LOCKED_GLYPH = '🔒';

/** Stage number → its category (the containing MAP_ROWS row's rightLabel). */
const CATEGORY_BY_STAGE: Readonly<Record<number, string>> = Object.fromEntries(
  MAP_ROWS.flatMap((row) =>
    row.stageNumbers.map((stageNumber): [number, string] => [stageNumber, row.rightLabel]),
  ),
);
/** Diameter of the current-stage marker dot in dp. */
const MARKER_SIZE = 10;
/** Side of the square color swatch in dp. */
const SWATCH_SIZE = 14;
/** Dim factor applied to a locked stage row. */
const LOCKED_ROW_OPACITY = 0.6;

interface JourneySummaryProps {
  currentStage: number;
  cycleNumber: number;
}

/** The "Stage N of 10 · Week W" read plus, past the first pass, its cycle. */
const JourneySummary = ({ currentStage, cycleNumber }: JourneySummaryProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const { read, cycleCaption } = useJourneySummary(currentStage, cycleNumber);
  return (
    <View testID="map-drawer-journey" style={styles.journey}>
      <Text style={[type(width).body, styles.journeyText]}>{read}</Text>
      {cycleCaption ? (
        <Text style={[type(width).caption, styles.cycle]}>{cycleCaption}</Text>
      ) : null}
    </View>
  );
};

/** "Unlocks in N days" estimate for a locked row, read from the calendar drip. */
const UnlockRow = ({ stageNumber }: { stageNumber: number }): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const daysUntil = useDaysUntilStage(stageNumber);
  return (
    <Text testID={`map-drawer-unlock-${stageNumber}`} style={[type(width).caption, styles.unlock]}>
      {unlockTimeline(daysUntil)}
    </Text>
  );
};

interface LegendRowProps {
  stageNumber: number;
  display: StageDisplay;
  locked: boolean;
  selected: boolean;
  onSelectStage: (_stageNumber: number) => void;
}

/** One tappable legend row: swatch, category, optional Aspect line, and the
 *  current-stage marker or a locked stage's padlock + unlock estimate. */
const LegendRow = ({
  stageNumber,
  display,
  locked,
  selected,
  onSelectStage,
}: LegendRowProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const category = CATEGORY_BY_STAGE[stageNumber] ?? '';
  const aspect = display.arrowLabel;
  return (
    <TouchableOpacity
      testID={`map-drawer-stage-${stageNumber}`}
      accessibilityRole="button"
      accessibilityLabel={drawerStageLabel(category, aspect, { locked, current: selected })}
      accessibilityState={{ selected }}
      onPress={() => onSelectStage(stageNumber)}
      style={[styles.row, selected ? styles.rowSelected : null, locked ? styles.rowLocked : null]}
    >
      <View
        testID={`map-drawer-swatch-${stageNumber}`}
        style={[styles.swatch, { backgroundColor: display.textColor }]}
      />
      <View style={styles.rowBody}>
        <Text style={[type(width).label, styles.category]} numberOfLines={1}>
          {category}
        </Text>
        {aspect ? (
          <Text style={[type(width).caption, styles.aspect]} numberOfLines={1}>
            {aspect}
          </Text>
        ) : null}
        {locked ? <UnlockRow stageNumber={stageNumber} /> : null}
      </View>
      {selected ? (
        <View testID={`map-drawer-current-${stageNumber}`} style={styles.currentMarker} />
      ) : null}
      {locked ? <Text style={styles.lockGlyph}>{LOCKED_GLYPH}</Text> : null}
    </TouchableOpacity>
  );
};

export interface MapDrawerProps {
  /** Stage number → loaded StageData, for resolving each row's lock state. */
  lookup: Readonly<Record<number, StageData | undefined>>;
  /** The stage the journey currently rests on, marked selected in the list. */
  currentStage: number;
  /** Which pass through the arc the user is on; past 1 it captions the cycle. */
  cycleNumber: number;
  /** Glide the lens to a stage, open its detail modal, and close the drawer. */
  onSelectStage: (_stageNumber: number) => void;
}

/** The stage legend for the Map header drawer: one row per stage, ascending. */
export default function MapDrawer({
  lookup,
  currentStage,
  cycleNumber,
  onSelectStage,
}: MapDrawerProps): React.JSX.Element {
  const stageNumbers = Array.from({ length: STAGE_COUNT }, (_, i) => i + 1);
  return (
    <View testID="map-drawer">
      <JourneySummary currentStage={currentStage} cycleNumber={cycleNumber} />
      {stageNumbers.map((stageNumber) => {
        const display = STAGE_DISPLAY[stageNumber];
        if (!display) return null;
        const stage = lookup[stageNumber];
        return (
          <LegendRow
            key={stageNumber}
            stageNumber={stageNumber}
            display={display}
            locked={stage ? !isStageUnlocked(stage, currentStage) : true}
            selected={stageNumber === currentStage}
            onSelectStage={onSelectStage}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  journey: {
    marginBottom: SPACING.md,
    gap: SPACING.xs,
  },
  journeyText: {
    color: ink.primary,
    fontWeight: '600',
  },
  cycle: {
    color: ink.muted,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: radius.sm,
  },
  rowSelected: {
    backgroundColor: surface.sunken,
  },
  rowLocked: {
    opacity: LOCKED_ROW_OPACITY,
  },
  swatch: {
    width: SWATCH_SIZE,
    height: SWATCH_SIZE,
    borderRadius: radius.sm,
  },
  rowBody: {
    flex: 1,
  },
  category: {
    color: ink.primary,
  },
  aspect: {
    color: ink.soft,
  },
  unlock: {
    color: ink.muted,
  },
  currentMarker: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: MARKER_SIZE / 2,
    backgroundColor: accent.primary,
  },
  lockGlyph: {
    color: ink.muted,
  },
});
