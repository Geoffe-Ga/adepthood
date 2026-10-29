import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import {
  arcSummary,
  birthMarkers,
  carryovers,
  cycleCaption,
  cycleLabels,
  cycleRows,
  energySummary,
  energyPoints,
  habitHistories,
  percent,
  ribbonBlocks,
  rhythmCaption,
  rhythmEnd,
  rhythmPoints,
  rhythmSummary,
  rhythmVisible,
  RHYTHM_EARLY_LINE,
  youAreHere,
} from './progressPresentation';
import { useProgressOverview } from './useProgressOverview';

import type { ApiProgressOverview } from '@/api';
import { Dumbbells, HistoryChart, Ribbon } from '@/components/charts';
import { ErrorFallback } from '@/components/ErrorFallback';
import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { ink, rhythm, SPACING, type as typeRamp } from '@/design/tokens';

/** The opacity held figures are drawn at while their fresh copy is read. */
export const HELD_OVERVIEW_OPACITY = 0.5;
const PERCENT_MAX = 100;

type Overview = ApiProgressOverview;

function useText() {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return {
    body: [t.body, styles.body],
    caption: [t.caption, styles.caption],
  };
}

function ArcSection({ overview }: { overview: Overview }) {
  const text = useText();
  const here = youAreHere(overview);
  const brought = carryovers(overview);
  return (
    <EditorialSection title="The arc" testID="progress-arc">
      {here ? (
        <Text testID="progress-here" style={text.body}>
          {here}
        </Text>
      ) : null}
      <Ribbon
        testID="progress-ribbon"
        blocks={ribbonBlocks(overview)}
        currentWeek={overview.arc.current_week ?? undefined}
        markers={birthMarkers(overview)}
        summary={arcSummary(overview)}
        showKey={false}
      />
      <Text style={text.body}>Units logged</Text>
      <HabitHistories overview={overview} carryover={false} />
      {brought.length > 0 ? (
        <View testID="progress-carryovers">
          <Text style={text.caption}>Brought with you</Text>
          <HabitHistories overview={overview} carryover />
        </View>
      ) : null}
    </EditorialSection>
  );
}

function HabitHistories({ overview, carryover }: { overview: Overview; carryover: boolean }) {
  const text = useText();
  return (
    <View style={styles.habitRows}>
      {habitHistories(overview)
        .filter((habit) => habit.carryover === carryover)
        .map((habit) => (
          <View key={habit.id} testID={`progress-habit-${habit.id}`} style={styles.habitRow}>
            <Text style={[text.caption, styles.habitName]}>{habit.name}</Text>
            <View style={styles.habitHistory}>
              {habit.histories.length > 0 ? (
                habit.histories.map((history) => (
                  <HistoryChart
                    key={history.unit}
                    testID={`progress-habit-${habit.id}-${history.unit}`}
                    points={history.points}
                    measure={history.measure}
                    color={habit.color}
                    compact
                    summary={`${habit.name}: daily ${history.measure} during this program.`}
                  />
                ))
              ) : (
                <Text style={text.caption}>No unit history yet.</Text>
              )}
            </View>
          </View>
        ))}
    </View>
  );
}

function RhythmSection({ overview }: { overview: Overview }) {
  const text = useText();
  const caption = rhythmCaption(overview);
  const end = rhythmEnd(overview);
  return (
    <EditorialSection title="Your rhythm" testID="progress-rhythm">
      {rhythmVisible(overview) ? (
        <>
          <HistoryChart
            testID="progress-wave"
            points={rhythmPoints(overview)}
            max={PERCENT_MAX}
            measure="Scheduled activities completed (%)"
            summary={rhythmSummary(overview)}
          />
          {end ? <Text style={text.caption}>{end}</Text> : null}
          {caption ? (
            <Text testID="progress-rhythm-caption" style={text.body}>
              {caption}
            </Text>
          ) : null}
        </>
      ) : (
        <Text testID="progress-rhythm-early" style={text.body}>
          {RHYTHM_EARLY_LINE}
        </Text>
      )}
    </EditorialSection>
  );
}

function CycleSection({ overview }: { overview: Overview }) {
  const text = useText();
  const rows = cycleRows(overview);
  if (rows.length === 0) return null;
  const labels = cycleLabels(overview);
  return (
    <EditorialSection title="This pass and the last" testID="progress-cycles">
      <Dumbbells
        testID="progress-dumbbells"
        rows={rows}
        fromLabel={labels.from}
        toLabel={labels.to}
        format={percent}
        summary={`Per stage, the share of scheduled days kept in ${labels.from.toLowerCase()} and ${labels.to.toLowerCase()}.`}
      />
      <Text style={text.caption}>{cycleCaption(overview)}</Text>
    </EditorialSection>
  );
}

function EnergySection({ overview }: { overview: Overview }) {
  const text = useText();
  return (
    <EditorialSection title="Net energy per week" testID="progress-energy">
      <Text testID="progress-energy-formula" style={text.caption}>
        {overview.energy.formula}
      </Text>
      <Text style={text.caption}>
        Energy returned minus effort spent on logged completions. Below zero means more effort spent
        than energy returned.
      </Text>
      <HistoryChart
        testID="progress-energy-columns"
        points={energyPoints(overview)}
        measure="Net energy (return − cost)"
        variant="columns"
        summary={energySummary(overview)}
      />
    </EditorialSection>
  );
}

function ProgressBody({ overview, held }: { overview: Overview; held: boolean }) {
  return (
    <View testID="progress-content" style={held ? { opacity: HELD_OVERVIEW_OPACITY } : undefined}>
      <ArcSection overview={overview} />
      <RhythmSection overview={overview} />
      <CycleSection overview={overview} />
      <EnergySection overview={overview} />
    </View>
  );
}

/**
 * The Map's Progress screen (#3528, epic #3519): the 36-week arc, the unnamed
 * rhythm wave, the comparison with the last pass and the energy ledger, all
 * drawn from ``GET /progress/overview``. Balance and trajectory, never altitude.
 */
export function ProgressScreen(): React.JSX.Element {
  const read = useProgressOverview();
  return (
    <ScreenScaffold scroll testID="progress-screen">
      <ScreenHeader
        title="Your progress"
        titleHidden
        lead="Where you are in the arc, and the shape of your own rising and resting."
      />
      {read.error !== null ? (
        <View testID="progress-error" style={styles.error}>
          <ErrorFallback
            heading="Your progress could not load."
            onRetry={() => void read.refresh()}
            retryAccessibilityLabel="Try loading your progress again"
            retryTestID="progress-retry"
          />
        </View>
      ) : null}
      {read.overview ? <ProgressBody overview={read.overview} held={read.loading} /> : null}
    </ScreenScaffold>
  );
}

export default ProgressScreen;

const styles = StyleSheet.create({
  body: { color: ink.soft },
  caption: { color: ink.muted },
  error: { marginTop: rhythm.sectionGap },
  habitRows: { gap: rhythm.sectionGap },
  habitRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  habitName: { flexBasis: '30%', flexShrink: 1 },
  habitHistory: { flex: 1, minWidth: 0 },
});
