import { CalendarDays } from 'lucide-react-native';
import React, { useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import {
  arcSummary,
  birthMarkers,
  CYCLE_CAPTION,
  cycleLabels,
  cycleRows,
  ENERGY_MEASURE,
  energyNow,
  energyPoints,
  energySummary,
  habitHistories,
  habitRange,
  percent,
  percentFigure,
  ribbonBlocks,
  rhythmCaption,
  rhythmNow,
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
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { ink, rhythm, type as typeRamp } from '@/design/tokens';
import type { StoryHabit } from '@/features/Habits/hooks/useHabitStory';
import { HabitStorySheet } from '@/features/Habits/story/HabitStorySheet';

/** The opacity held figures are drawn at while their fresh copy is read. */
export const HELD_OVERVIEW_OPACITY = 0.5;
const PERCENT_MAX = 100;
export const RHYTHM_MEASURE = 'Scheduled kept, last 7 days';

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
  return (
    <EditorialSection title="The arc" testID="progress-arc">
      <Ribbon
        testID="progress-ribbon"
        title={youAreHere(overview) ?? undefined}
        blocks={ribbonBlocks(overview)}
        currentWeek={overview.arc.current_week ?? undefined}
        markers={birthMarkers(overview)}
        summary={arcSummary(overview)}
        showKey={false}
      />
    </EditorialSection>
  );
}

type Habit = ReturnType<typeof habitHistories>[number];

type OpenStory = (_habit: StoryHabit) => void;

/** The habit's first line carries the door to its Story: the heat map, the ledger. */
const storyDoor = (habit: Habit, onOpenStory: OpenStory) => ({
  label: 'Story',
  hint: `Opens the story of ${habit.name}`,
  icon: CalendarDays,
  onPress: () => onOpenStory({ id: habit.id, name: habit.name }),
});

function HabitRows({ habits, onOpenStory }: { habits: readonly Habit[]; onOpenStory: OpenStory }) {
  return (
    <View style={styles.rows}>
      {habits.flatMap((habit) =>
        habit.histories.map((history, index) => (
          <HistoryChart
            key={`${habit.id}-${history.unit}`}
            testID={`progress-habit-${habit.id}-${history.unit}`}
            points={history.points}
            measure={habit.histories.length > 1 ? `${habit.name} · ${history.unit}` : habit.name}
            unit={history.perDay}
            aside={history.now}
            color={habit.color}
            compact
            door={index === 0 ? storyDoor(habit, onOpenStory) : undefined}
            summary={`${habit.name}: ${history.perDay}, as a 7-day average over this program. Now ${history.now}.`}
          />
        )),
      )}
    </View>
  );
}

function HabitsSection({ overview, onOpenStory }: { overview: Overview; onOpenStory: OpenStory }) {
  const text = useText();
  const habits = habitHistories(overview);
  const range = habitRange(overview);
  const program = habits.filter((habit) => !habit.carryover);
  const brought = habits.filter((habit) => habit.carryover);
  return (
    <EditorialSection title="Your habits" testID="progress-habits">
      <Text style={text.caption}>{range ?? 'Nothing logged yet.'}</Text>
      <HabitRows habits={program} onOpenStory={onOpenStory} />
      {brought.length > 0 ? (
        <View testID="progress-carryovers" style={styles.subsection}>
          <Text style={text.caption}>Brought with you</Text>
          <HabitRows habits={brought} onOpenStory={onOpenStory} />
        </View>
      ) : null}
    </EditorialSection>
  );
}

function RhythmSection({ overview }: { overview: Overview }) {
  const text = useText();
  const caption = rhythmCaption(overview);
  return (
    <EditorialSection title="Your rhythm" testID="progress-rhythm">
      {rhythmVisible(overview) ? (
        <>
          <HistoryChart
            testID="progress-wave"
            points={rhythmPoints(overview)}
            max={PERCENT_MAX}
            measure={RHYTHM_MEASURE}
            format={percentFigure}
            aside={rhythmNow(overview) ?? undefined}
            summary={rhythmSummary(overview)}
          />
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
        summary={`Per stage, the share of scheduled asks kept in ${labels.from.toLowerCase()} and ${labels.to.toLowerCase()}.`}
      />
      <Text style={text.caption}>{CYCLE_CAPTION}</Text>
    </EditorialSection>
  );
}

function EnergySection({ overview }: { overview: Overview }) {
  return (
    <EditorialSection title="Net energy" testID="progress-energy">
      <HistoryChart
        testID="progress-energy-columns"
        points={energyPoints(overview)}
        measure={ENERGY_MEASURE}
        aside={energyNow(overview) ?? undefined}
        variant="columns"
        summary={energySummary(overview)}
      />
    </EditorialSection>
  );
}

function ProgressBody({ overview, held }: { overview: Overview; held: boolean }) {
  const [story, setStory] = useState<StoryHabit | null>(null);
  return (
    <View testID="progress-content" style={held ? { opacity: HELD_OVERVIEW_OPACITY } : undefined}>
      <ArcSection overview={overview} />
      <RhythmSection overview={overview} />
      <CycleSection overview={overview} />
      <HabitsSection overview={overview} onOpenStory={setStory} />
      <EnergySection overview={overview} />
      <HabitStorySheet visible={story !== null} habit={story} onClose={() => setStory(null)} />
    </View>
  );
}

/**
 * The Map's Progress screen (#3528, epic #3519): the 36-week arc, the unnamed
 * rhythm wave, the comparison with the last pass, each habit's 7-day average
 * and the energy ledger, all drawn from ``GET /progress/overview``. The stack
 * header names the screen; every chart says what it shows once, on its own
 * header row. Balance and trajectory, never altitude.
 */
export function ProgressScreen(): React.JSX.Element {
  const read = useProgressOverview();
  return (
    <ScreenScaffold scroll testID="progress-screen">
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
  rows: { gap: rhythm.blockGap, marginTop: rhythm.blockGap },
  subsection: { marginTop: rhythm.sectionGap },
});
