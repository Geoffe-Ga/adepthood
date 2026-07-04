/**
 * Pure habit-count helpers shared by summary surfaces (e.g. the journal stat
 * tiles). Kept free of any store or hook usage so callers pass in the habit
 * list they already subscribe to, rather than reading an imperative snapshot.
 */
import type { Habit } from '@/features/Habits/Habits.types';
import { isHabitUnlocked } from '@/features/Habits/HabitUtils';
import { DEFAULT_TIMEZONE, dayKeyInTZ } from '@/utils/dateUtils';

/**
 * Count habits with a real completion on today's calendar day — a completion
 * with `completed_units > 0` bucketed into today's day for the given timezone.
 *
 * `tz` defaults to `DEFAULT_TIMEZONE`, but callers that know the user's zone
 * (the journal habit tile passes the auth-hydrated one) should thread it so the
 * "today" bucket matches the user's calendar day near a midnight boundary.
 */
export function countDoneToday(habits: readonly Habit[], tz: string = DEFAULT_TIMEZONE): number {
  const todayKey = dayKeyInTZ(new Date(), tz);
  return habits.filter((h) =>
    (h.completions ?? []).some(
      (c) => c.completed_units > 0 && dayKeyInTZ(c.timestamp, tz) === todayKey,
    ),
  ).length;
}

/**
 * The subset of unlocked habits — those the user has revealed. Unlock is
 * governed solely by `revealed` (see {@link isHabitUnlocked}); neither the
 * Spiral-Dynamics stage nor the calendar `start_date` participates, so no
 * current-stage argument is needed.
 */
export function unlockedHabits(habits: readonly Habit[]): Habit[] {
  return habits.filter((h) => isHabitUnlocked(h));
}
