import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import React from 'react';
import { Animated, Pressable, Text } from 'react-native';

import InvitationNote from './InvitationNote';
import { todayStyles as s } from './Today.styles';
import { useInvitations } from './useInvitations';

import { EmptyState } from '@/components/feedback/EmptyState';
import { SkeletonCard } from '@/components/feedback/Skeleton';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { ShowcaseCard } from '@/components/layout/ShowcaseCard';
import { STAGE_ORDER } from '@/design/tokens';
import type { Habit } from '@/features/Habits/Habits.types';
import { useEntrance } from '@/hooks/useEntrance';
import type { RootTabParamList } from '@/navigation/BottomTabs';
import { useHabitStore } from '@/store/useHabitStore';
import {
  TOTAL_PROGRAM_WEEKS,
  programStage,
  programWeek,
  selectProgramStartDate,
  useProgramStore,
} from '@/store/useProgramStore';
import { DEFAULT_TIMEZONE, dayKeyInTZ } from '@/utils/dateUtils';

type TodayNav = BottomTabNavigationProp<RootTabParamList>;

/** A morning/afternoon/evening greeting from the local clock. */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Count habits with a real completion on today's calendar day.
 *
 * Pure (takes the habits it counts) so callers subscribe to the store reactively
 * rather than reading an imperative snapshot in a render path.
 */
function countDoneToday(habits: readonly Habit[]): number {
  const todayKey = dayKeyInTZ(new Date(), DEFAULT_TIMEZONE);
  return habits.filter((h) =>
    (h.completions ?? []).some(
      (c) => c.completed_units > 0 && dayKeyInTZ(c.timestamp, DEFAULT_TIMEZONE) === todayKey,
    ),
  ).length;
}

/** The showcase hero: greeting + position in the 36-week journey. */
const TodayHero = ({ week, stage }: { week: number | null; stage: number | null }) => {
  const entrance = useEntrance(0);
  const position = week === null ? 'Your journey awaits' : `Week ${week} of ${TOTAL_PROGRAM_WEEKS}`;
  const stageName = stage === null ? null : STAGE_ORDER[stage - 1] ?? null;
  return (
    <Animated.View style={entrance}>
      <ShowcaseCard testID="today-hero">
        <Text style={s.heroEyebrow}>Today</Text>
        <Text style={s.heroGreeting} accessibilityRole="header">
          {greeting()}
        </Text>
        <Text style={s.heroLead}>{stageName ? `${position} · ${stageName}` : position}</Text>
      </ShowcaseCard>
    </Animated.View>
  );
};

interface BandProps {
  index: number;
  title: string;
  value?: string;
  subtitle: string;
  onPress: () => void;
  testID: string;
}

/** A staggered, tappable summary band that routes into a feature tab. */
const TodayBand = ({ index, title, value, subtitle, onPress, testID }: BandProps) => {
  const entrance = useEntrance(index);
  return (
    <Animated.View style={entrance}>
      <Pressable
        style={s.band}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${subtitle}`}
        testID={testID}
      >
        <Text style={s.bandTitle}>{title}</Text>
        {value ? <Text style={s.bandValue}>{value}</Text> : null}
        <Text style={s.bandSubtitle}>{subtitle}</Text>
        <Text style={s.bandCue}>Open →</Text>
      </Pressable>
    </Animated.View>
  );
};

/** Today's-habits band: skeleton while loading, empty state with no habits. */
const HabitsBand = ({ index, onPress }: { index: number; onPress: () => void }) => {
  const loading = useHabitStore((state) => state.loading);
  const habits = useHabitStore((state) => state.habits);
  const total = habits.length;
  if (loading && total === 0) return <SkeletonCard testID="today-habits-skeleton" />;
  if (total === 0) {
    return (
      <EmptyState
        glyph="🌱"
        title="No habits yet"
        body="Plant your first habit to start the daily rhythm."
        cta={
          <Pressable
            style={s.band}
            onPress={onPress}
            accessibilityRole="button"
            testID="today-habits-empty-cta"
          >
            <Text style={s.bandCue}>Add a habit →</Text>
          </Pressable>
        }
      />
    );
  }
  const done = countDoneToday(habits);
  return (
    <TodayBand
      index={index}
      title="Today's habits"
      value={`${done}/${total} done`}
      subtitle={done >= total ? 'All caught up — beautiful.' : 'Keep the streak alive.'}
      onPress={onPress}
      testID="today-habits-band"
    />
  );
};

/** The pending invitations (NORTH-STAR §6): silent when empty, one card each. */
const InvitationStack = (): React.JSX.Element | null => {
  const { invitations, dismiss } = useInvitations();
  if (invitations.length === 0) return null;
  return (
    <>
      {invitations.map((invitation) => (
        <InvitationNote key={invitation.id} invitation={invitation} onDismiss={dismiss} />
      ))}
    </>
  );
};

/** The editorial home tab: where am I in the journey, and what's next today. */
const TodayScreen = (): React.JSX.Element => {
  const navigation = useNavigation<TodayNav>();
  const anchor = useProgramStore(selectProgramStartDate);
  const week = programWeek(anchor);
  const stage = programStage(anchor);
  return (
    <ScreenScaffold scroll testID="today-screen">
      <TodayHero week={week} stage={stage} />
      <InvitationStack />
      <HabitsBand index={1} onPress={() => navigation.navigate('Habits')} />
      <TodayBand
        index={2}
        title="A practice to begin"
        subtitle="Settle in with today's practice."
        onPress={() => navigation.navigate('Practice')}
        testID="today-practice-band"
      />
      <TodayBand
        index={3}
        title="Reflect in the journal"
        subtitle={week === null ? 'Open your journal.' : `This week's reflection awaits.`}
        onPress={() => navigation.navigate('Journal')}
        testID="today-journal-band"
      />
      <TodayBand
        index={4}
        title="Continue the course"
        subtitle="Pick up where you left off."
        onPress={() => navigation.navigate('Course')}
        testID="today-course-band"
      />
    </ScreenScaffold>
  );
};

export default TodayScreen;
