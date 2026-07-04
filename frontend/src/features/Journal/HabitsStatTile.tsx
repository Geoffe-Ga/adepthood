/**
 * The journal "Today's habits" stat tile: a compact summary of how many of the
 * user's unlocked habits are done today, with graceful loading, empty, and
 * still-locked states. Loads habits on mount and taps through to the Habits tab.
 */
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import React, { useEffect } from 'react';

import StatTile from './StatTile';

import { useAuth } from '@/context/AuthContext';
import { countDoneToday, unlockedAtStage } from '@/features/Habits/habitCounts';
import { habitManager } from '@/features/Habits/services/habitManager';
import { stageService } from '@/features/Map/services/stageService';
import type { RootTabParamList } from '@/navigation/BottomTabs';
import { useHabitStore } from '@/store/useHabitStore';
import {
  selectCurrentStage,
  selectStages,
  selectStagesError,
  selectStagesLoading,
  useStageStore,
} from '@/store/useStageStore';

type HabitsTileNav = BottomTabNavigationProp<RootTabParamList>;

const TITLE = "Today's habits";
const OPEN_CUE = 'Open habits →';
const ADD_CUE = 'Add a habit →';

/**
 * Stage to assume when stage loading has failed and left the store empty: one
 * habit is always unlocked, so falling back to 1 (rather than a possibly-stale
 * store value) keeps the denominator conservative.
 */
const FALLBACK_STAGE = 1;

interface HabitsDescriptor {
  loading: boolean;
  stat?: string;
  cue: string;
  accessibilityLabel: string;
}

/**
 * Resolve the tile's stat line, cue, loading flag, and a11y label from plain
 * counts. `loading` is the caller's precomputed "show skeleton" flag (habits or
 * stages still resolving), so this stays pure and flat.
 */
export function describeHabits(
  loading: boolean,
  habitCount: number,
  unlockedCount: number,
  doneCount: number,
): HabitsDescriptor {
  if (loading) {
    return { loading: true, cue: OPEN_CUE, accessibilityLabel: `${TITLE}, loading. Open habits` };
  }
  if (habitCount === 0) {
    return {
      loading: false,
      stat: 'No habits yet',
      cue: ADD_CUE,
      accessibilityLabel: `${TITLE}, no habits yet. Add a habit`,
    };
  }
  if (unlockedCount === 0) {
    // Defensive: the current stage always floors at 1, so the first habit is
    // unlocked whenever any exist. Kept as a guard for a zero-unlocked corpus.
    return {
      loading: false,
      stat: 'Unlocks soon',
      cue: OPEN_CUE,
      accessibilityLabel: `${TITLE}, unlocks soon. Open habits`,
    };
  }
  return {
    loading: false,
    stat: `${doneCount}/${unlockedCount} done`,
    cue: OPEN_CUE,
    accessibilityLabel: `${TITLE}, ${doneCount} of ${unlockedCount} done. Open habits`,
  };
}

const HabitsStatTile = (): React.JSX.Element => {
  const navigation = useNavigation<HabitsTileNav>();
  const { userTimezone } = useAuth();
  const habitsLoading = useHabitStore((state) => state.loading);
  const habits = useHabitStore((state) => state.habits);
  const currentStage = useStageStore(selectCurrentStage);
  const stages = useStageStore(selectStages);
  const stagesLoading = useStageStore(selectStagesLoading);
  const stagesError = useStageStore(selectStagesError);

  useEffect(() => {
    void habitManager.loadHabits(userTimezone);
  }, [userTimezone]);

  useEffect(() => {
    if (stages.length === 0) void stageService.loadStages();
  }, [stages.length]);

  // Stages have not resolved yet — either nothing has errored, or a (re)load is
  // in flight. Hold the skeleton so the tile never flashes a denominator
  // computed against an empty stage list.
  const stagesPending = stages.length === 0 && (stagesError === null || stagesLoading);
  // A failed load leaves stages empty; trust the always-unlocked floor rather
  // than a possibly-stale store `currentStage`.
  const stagesFailed = stagesError !== null && stages.length === 0;
  const effectiveStage = stagesFailed ? FALLBACK_STAGE : currentStage;

  const unlocked = unlockedAtStage(habits, effectiveStage);
  const showSkeleton = (habitsLoading && habits.length === 0) || stagesPending;
  const descriptor = describeHabits(
    showSkeleton,
    habits.length,
    unlocked.length,
    countDoneToday(unlocked, userTimezone),
  );

  return (
    <StatTile
      testID="journal-habits-tile"
      title={TITLE}
      cue={descriptor.cue}
      stat={descriptor.stat}
      loading={descriptor.loading}
      accessibilityLabel={descriptor.accessibilityLabel}
      onPress={() => navigation.navigate('Habits')}
    />
  );
};

export default HabitsStatTile;
