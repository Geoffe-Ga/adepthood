/**
 * `useHabitsSummary` owns the "Today's habits" tile's data-loading: it triggers
 * the habit fetch on mount and on every return to the shelf, subscribes to the
 * day boundary, reads the habit-store slices, and assembles the plain counts
 * the tile renders — keeping `HabitsStatTile` presentational, mirroring
 * `useWeeklyProgress` for the practice bar.
 */
import { useCallback, useEffect } from 'react';

import { useAuth } from '@/context/AuthContext';
import { countDoneToday, unlockedHabits } from '@/features/Habits/habitCounts';
import { habitManager } from '@/features/Habits/services/habitManager';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';
import { useHabitStore } from '@/store/useHabitStore';
import { useDayKey } from '@/utils/dayRollover';

export interface HabitsSummary {
  showSkeleton: boolean;
  habitCount: number;
  unlockedCount: number;
  doneCount: number;
}

export function useHabitsSummary(): HabitsSummary {
  const { userTimezone } = useAuth();
  const habitsLoading = useHabitStore((state) => state.loading);
  const habits = useHabitStore((state) => state.habits);

  useEffect(() => {
    void habitManager.loadHabits(userTimezone);
  }, [userTimezone]);
  // The shelf stays mounted once visited, so without this the read above is
  // the only one it ever does (#2764) — the same treatment entries and the
  // weekly prompt got in #2358.
  useRefetchOnFocus(
    useCallback(() => {
      void habitManager.loadHabits(userTimezone);
    }, [userTimezone]),
  );
  // `countDoneToday` buckets into "today" at call time, which is correct; this
  // is what asks it again when "today" changes underneath a mounted shelf. The
  // key itself is unused — the subscription is the point.
  useDayKey(userTimezone);

  // Unlock is governed solely by the persisted revealed flag.
  const unlocked = unlockedHabits(habits);
  const showSkeleton = habitsLoading && habits.length === 0;

  return {
    showSkeleton,
    habitCount: habits.length,
    unlockedCount: unlocked.length,
    doneCount: countDoneToday(unlocked, userTimezone),
  };
}
