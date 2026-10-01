import { periodProgress, type PeriodUnit } from '../../utils/dateUtils';

import { habitCadence } from './habitCadence';
import type { Habit } from './Habits.types';
import { isSubtractiveHabit } from './HabitUtils';

/** Where a weekly or monthly habit stands in its current period. */
export interface StreakPeriod {
  unit: PeriodUnit;
  doneDays: number;
  daysNeeded: number;
}

/** Suffix the tile appends on the day every tier is met; pinned by the day-rollover tests. */
const ACHIEVED_SUFFIX = ' — Achieved Today!';
/** Separator between the period count and the in-period progress. */
const PROGRESS_SEPARATOR = ' · ';

const pluralise = (noun: string, count: number): string => (count === 1 ? noun : `${noun}s`);

/**
 * The tile's streak line. A daily habit keeps its historic `"3 DAYS"` text;
 * a weekly or monthly one reads `"2 WEEKS · 2/4 DAYS"` — the server's period
 * streak, then done days so far in the current period over the days needed.
 * Both take the same achieved suffix.
 */
export const formatStreakLabel = (
  streak: number,
  hasCompletedGoal: boolean,
  period?: StreakPeriod,
): string => {
  const body = period
    ? `${streak} ${pluralise(period.unit, streak)}${PROGRESS_SEPARATOR}${period.doneDays}/${period.daysNeeded} days`
    : `${streak} days`;
  return `${body}${hasCompletedGoal ? ACHIEVED_SUFFIX : ''}`.toUpperCase();
};

/**
 * The current-period progress a tile shows beside its streak, or `undefined`
 * for a habit whose streak is counted in days: a daily cadence, or a
 * subtractive habit, whose abstention streak is daily whatever its low tier
 * says. Buckets by `local_day` where a row carries one, as the stats do.
 */
export const streakPeriodFor = (
  habit: Habit,
  tz: string,
  now: Date = new Date(),
): StreakPeriod | undefined => {
  if (isSubtractiveHabit(habit)) return undefined;
  const cadence = habitCadence(habit.goals);
  if (cadence.unit === 'day') return undefined;
  const completions = (habit.completions ?? []).map((c) => ({
    timestamp: c.local_day ?? c.timestamp,
    completed_units: c.completed_units,
  }));
  return { unit: cadence.unit, ...periodProgress(completions, cadence, tz, now) };
};
