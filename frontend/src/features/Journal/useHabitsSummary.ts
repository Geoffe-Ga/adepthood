/**
 * `useHabitsSummary` owns the "Today's habits" tile's data-loading: it triggers
 * the habit fetch on mount, reads the habit-store slices, and assembles the
 * plain counts the tile renders — keeping `HabitsStatTile` presentational,
 * mirroring `useWeeklyProgress` for the practice bar.
 */
import { useEffect } from 'react';

import { useAuth } from '@/context/AuthContext';
import { countDoneToday, unlockedHabits } from '@/features/Habits/habitCounts';
import { habitManager } from '@/features/Habits/services/habitManager';
import { useHabitStore } from '@/store/useHabitStore';

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
