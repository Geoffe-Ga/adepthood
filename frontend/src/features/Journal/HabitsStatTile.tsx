/**
 * The journal "Today's habits" stat tile: a compact summary of how many of the
 * user's unlocked habits are done today, with graceful loading, empty, and
 * still-locked states. Loads habits on mount and taps through to the Habits tab.
 */
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import React from 'react';

import StatTile from './StatTile';
import { useHabitsSummary } from './useHabitsSummary';

import type { RootTabParamList } from '@/navigation/BottomTabs';

type HabitsTileNav = BottomTabNavigationProp<RootTabParamList>;

const TITLE = "Today's habits";
const OPEN_CUE = 'Open habits →';
const ADD_CUE = 'Add a habit →';

interface HabitsDescriptor {
  loading: boolean;
  stat?: string;
  cue: string;
  accessibilityLabel: string;
}

/**
 * Resolve the tile's stat line, cue, loading flag, and a11y label from plain
 * counts. `loading` is the caller's precomputed "show skeleton" flag (habits
 * still resolving) — not the raw habit-store `loading` — so this stays pure and
 * flat.
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
    // Habits are locked by default now; with a corpus but nothing unlocked,
    // invite the user to open one rather than implying a timed auto-unlock.
    return {
      loading: false,
      stat: 'Unlock a habit to begin',
      cue: OPEN_CUE,
      accessibilityLabel: `${TITLE}, unlock a habit to begin. Open habits`,
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
  const { showSkeleton, habitCount, unlockedCount, doneCount } = useHabitsSummary();
  const descriptor = describeHabits(showSkeleton, habitCount, unlockedCount, doneCount);

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
