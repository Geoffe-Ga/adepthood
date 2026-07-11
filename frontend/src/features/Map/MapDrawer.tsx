/**
 * The Map header-drawer body: a compact legend of all ten stages rendered as
 * ``ScreenDrawer`` children (the panel supplies the scroll surface, so this maps
 * plain rows). Each row shows the stage's color swatch, persona/descriptor, and
 * its wheel-of-wholeness balance read; the current stage is marked, and a locked
 * stage carries a padlock plus its calendar unlock estimate. Tapping any row —
 * locked or not — glides the magnifier lens to that stage and closes the drawer.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';

import { SPACING, accent, ink, radius, surface, touchTarget, type } from '../../design/tokens';
import { useDaysUntilStage } from '../../store/useProgramProgression';

import { useJourneySummary } from './hooks/useJourneySummary';
import { unlockTimeline } from './journeyNarrative';
import { STAGE_DISPLAY, type StageDisplay } from './mapLayout';
import { isStageUnlocked } from './services/stageService';
import { STAGE_COUNT, type StageData } from './stageData';
import { balanceLabelSuffix, stageNodeLabel, THIN_FULLNESS } from './stageLegend';

/** Glyph shown on a locked stage row. */
const LOCKED_GLYPH = '🔒';
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
  fullness: number;
  locked: boolean;
  selected: boolean;
  onSelectStage: (_stageNumber: number) => void;
}

/** One tappable legend row: swatch, persona/descriptor, balance read, and the
 *  current-stage marker or a locked stage's padlock + unlock estimate. */
const LegendRow = ({
  stageNumber,
  display,
  fullness,
  locked,
  selected,
  onSelectStage,
}: LegendRowProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  return (
    <TouchableOpacity
      testID={`map-drawer-stage-${stageNumber}`}
      accessibilityRole="button"
      accessibilityLabel={stageNodeLabel(display, fullness)}
      accessibilityState={{ selected }}
      onPress={() => onSelectStage(stageNumber)}
      style={[styles.row, selected ? styles.rowSelected : null, locked ? styles.rowLocked : null]}
    >
      <View
        testID={`map-drawer-swatch-${stageNumber}`}
        style={[styles.swatch, { backgroundColor: display.textColor }]}
      />
      <View style={styles.rowBody}>
        <Text style={[type(width).label, styles.persona]} numberOfLines={1}>
          {display.persona}
        </Text>
        <Text style={[type(width).caption, styles.descriptor]} numberOfLines={1}>
          {display.descriptor}
        </Text>
        <Text style={[type(width).caption, styles.balanceRead]}>
          {balanceLabelSuffix(fullness)}
        </Text>
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
  /** Wheel-of-wholeness fullness (0..1) by stage; absent reads thin. */
  fullnessByStage: Readonly<Record<number, number>>;
  /** Which pass through the arc the user is on; past 1 it captions the cycle. */
  cycleNumber: number;
  /** Glide the magnifier lens to a stage and close the drawer. */
  onSelectStage: (_stageNumber: number) => void;
}

/** The stage legend for the Map header drawer: one row per stage, ascending. */
export default function MapDrawer({
  lookup,
  currentStage,
  fullnessByStage,
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
            fullness={fullnessByStage[stageNumber] ?? THIN_FULLNESS}
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
  persona: {
    color: ink.primary,
  },
  descriptor: {
    color: ink.soft,
  },
  balanceRead: {
    color: ink.muted,
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
