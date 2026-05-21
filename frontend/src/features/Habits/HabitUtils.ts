import { v4 as uuidv4 } from 'uuid';

import type { ApiHabitStats } from '../../api';
import { STAGE_DURATIONS_DAYS } from '../../constants/program';
import { brightenColor, colors, STAGE_COLORS, STAGE_ORDER } from '../../design/tokens';
import {
  DEFAULT_TIMEZONE,
  dayKeyInTZ,
  streakFromCompletions,
  todayInUserTZ,
} from '../../utils/dateUtils';

import type { Goal, Habit, Completion, HabitStatsData } from './Habits.types';

export { STAGE_ORDER };
// Re-export so existing call sites stay valid; canonical definition lives in src/constants/program.ts.
export { STAGE_DURATIONS_DAYS };

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Calculate the start date for a habit based on its order in the onboarding
 * flow. Habits 1–8 begin 21 days apart while habits 9–10 begin 42 days apart.
 *
 * Returns a UTC-anchored `Date` so caller-side ms arithmetic stays
 * stable across DST.  The user-perception fix for BUG-FE-HABIT-206
 * (showing the right calendar day in the tile) lives at the display
 * layer via `dayKeyInTZ(habit.start_date, user.timezone)` — that is
 * tracked in Wave 4 (`14-frontend-feature-screens.md`) where every
 * Habits-screen render path is migrated to read the user's TZ from
 * the auth context.  Doing it here would break the time-of-day
 * preserving contract many call sites depend on for ordering.
 *
 * @param baseDate - The starting date selected by the user (UTC anchor)
 * @param index - Zero-based habit index in the ordered list
 * @returns A new Date offset by the cumulative stage durations
 */
export const calculateHabitStartDate = (baseDate: Date, index: number): Date => {
  const date = new Date(baseDate);
  const offset = STAGE_DURATIONS_DAYS.slice(0, index).reduce((sum, d) => sum + d, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
};

export const getTierColor = (tier: 'low' | 'clear' | 'stretch') => {
  switch (tier) {
    case 'low':
      return colors.tier.low;
    case 'clear':
      return colors.tier.clear;
    case 'stretch':
      return colors.tier.stretch;
    default:
      return colors.tier.default;
  }
};

export const clampPercentage = (value: number): number => Math.min(100, Math.max(0, value));

export const isGoalAchieved = (
  goal: Goal,
  habit: Habit,
  tz: string = DEFAULT_TIMEZONE,
): boolean => {
  const todayProgress = calculateTodaysProgress(habit, tz);
  const targetValue = getGoalTarget(goal);
  return goal.is_additive ? todayProgress >= targetValue : todayProgress <= targetValue;
};

/** LG/CG/SG on a unified 0-100 bar; missing-tier collapses to {0,0,0} as a failure signal. */
export const getMarkerPositions = (
  lowGoal?: Goal,
  clearGoal?: Goal,
  stretchGoal?: Goal,
): { low: number; clear: number; stretch: number } => {
  if (!lowGoal || !clearGoal || !stretchGoal) {
    return { low: 0, clear: 0, stretch: 0 };
  }

  const lowTarget = getGoalTarget(lowGoal);
  const clearTarget = getGoalTarget(clearGoal);
  const stretchTarget = getGoalTarget(stretchGoal);

  if (lowGoal.is_additive) {
    if (stretchTarget <= 0) return { low: 0, clear: 50, stretch: 100 };
    return {
      low: clampPercentage((lowTarget / stretchTarget) * 100),
      clear: clampPercentage((clearTarget / stretchTarget) * 100),
      stretch: 100,
    };
  }

  const range = lowTarget - stretchTarget;
  if (range <= 0) return { low: 0, clear: 50, stretch: 100 };
  return {
    low: 0,
    clear: clampPercentage(((lowTarget - clearTarget) / range) * 100),
    stretch: 100,
  };
};

/**
 * Generate evenly-spaced increment values for a goal's progress stepper.
 *
 * The number of steps shown depends on the target magnitude:
 * - target <= 5: one button per unit (e.g. 1, 2, 3 for target=3)
 * - target <= 10: 5 evenly-spaced fractions
 * - target <= 100: 5 evenly-spaced increments, rounded up
 * - target > 100: 4 increments (avoids crowding the UI with a 5th
 *   button when increments are already large)
 */
const MAX_INCREMENT_STEPS = 5;
const LARGE_TARGET_STEPS = 4;

export const calculateProgressIncrements = (goal: Goal): number[] => {
  const { target } = goal;

  if (target <= MAX_INCREMENT_STEPS) {
    return Array.from({ length: target }, (_, i) => i + 1);
  } else if (target <= 10) {
    return Array.from(
      { length: MAX_INCREMENT_STEPS },
      (_, i) => ((i + 1) * target) / MAX_INCREMENT_STEPS,
    );
  } else if (target <= 100) {
    return Array.from({ length: MAX_INCREMENT_STEPS }, (_, i) =>
      Math.ceil(((i + 1) * target) / MAX_INCREMENT_STEPS),
    );
  } else {
    const increment = Math.ceil(target / MAX_INCREMENT_STEPS);
    return Array.from({ length: LARGE_TARGET_STEPS }, (_, i) => (i + 1) * increment);
  }
};

const DAYS_PER_WEEK = 7;
/** Average days per month (365.25 / 12) for daily-equivalent normalization. */
const APPROX_DAYS_PER_MONTH = 30.437;

export const getGoalTarget = (goal: Goal): number => {
  if (!goal) return 0;
  if (goal.frequency_unit === 'per_day') {
    return goal.target;
  }
  if (goal.frequency_unit === 'per_week') {
    return (goal.target / DAYS_PER_WEEK) * goal.frequency;
  }
  if (goal.frequency_unit === 'per_month') {
    return (goal.target / APPROX_DAYS_PER_MONTH) * goal.frequency;
  }
  return goal.target;
};

/** All-time sum across all completions (BUG-FE-HABIT-301); display paths use `calculateTodaysProgress`. */
export const calculateHabitProgress = (habit: Habit): number => {
  if (!habit.completions || habit.completions.length === 0) {
    return 0;
  }
  return habit.completions.reduce((sum, c) => sum + c.completed_units, 0);
};

/** Sum of completion units bucketed into the user's `tz` calendar day (drives the progress bar reset). */
export const calculateTodaysProgress = (habit: Habit, tz: string = DEFAULT_TIMEZONE): number => {
  if (!habit.completions || habit.completions.length === 0) {
    return 0;
  }
  const todayKey = todayInUserTZ(tz);
  let total = 0;
  for (const c of habit.completions) {
    if (dayKeyInTZ(c.timestamp, tz) === todayKey) {
      total += c.completed_units;
    }
  }
  return total;
};

interface GoalTierResult {
  currentGoal: Goal;
  nextGoal: Goal | null;
  completedAllGoals: boolean;
}

const resolveAdditiveTier = (
  totalProgress: number,
  lowGoal: Goal,
  clearGoal: Goal,
  stretchGoal: Goal,
): GoalTierResult => {
  if (totalProgress >= getGoalTarget(stretchGoal)) {
    return { currentGoal: stretchGoal, nextGoal: null, completedAllGoals: true };
  }
  if (totalProgress >= getGoalTarget(clearGoal)) {
    return { currentGoal: clearGoal, nextGoal: stretchGoal, completedAllGoals: false };
  }
  if (totalProgress >= getGoalTarget(lowGoal)) {
    return { currentGoal: lowGoal, nextGoal: clearGoal, completedAllGoals: false };
  }
  return { currentGoal: lowGoal, nextGoal: null, completedAllGoals: false };
};

const resolveSubtractiveTier = (
  totalProgress: number,
  lowGoal: Goal,
  clearGoal: Goal,
  stretchGoal: Goal,
): GoalTierResult => {
  const lowLimit = getGoalTarget(lowGoal);
  const clearLimit = getGoalTarget(clearGoal);
  const stretchLimit = getGoalTarget(stretchGoal);

  const isUnderStretch = totalProgress <= stretchLimit;
  const isUnderClear = totalProgress <= clearLimit;
  const isUnderLow = totalProgress <= lowLimit;

  if (isUnderStretch) {
    return { currentGoal: stretchGoal, nextGoal: null, completedAllGoals: true };
  }
  if (isUnderClear) {
    return { currentGoal: clearGoal, nextGoal: stretchGoal, completedAllGoals: false };
  }
  if (isUnderLow) {
    return { currentGoal: lowGoal, nextGoal: clearGoal, completedAllGoals: false };
  }
  return { currentGoal: lowGoal, nextGoal: null, completedAllGoals: false };
};

const TIER_ORDER = { low: 1, clear: 2, stretch: 3 } as const;

export const getGoalTier = (habit: Habit, tz: string = DEFAULT_TIMEZONE): GoalTierResult => {
  const sortedGoals = [...habit.goals].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);

  const lowGoal = sortedGoals[0];
  const clearGoal = sortedGoals[1];
  const stretchGoal = sortedGoals[2];

  if (!lowGoal || !clearGoal || !stretchGoal) {
    return { currentGoal: habit.goals[0]!, nextGoal: null, completedAllGoals: false };
  }

  const todayProgress = calculateTodaysProgress(habit, tz);
  return lowGoal.is_additive
    ? resolveAdditiveTier(todayProgress, lowGoal, clearGoal, stretchGoal)
    : resolveSubtractiveTier(todayProgress, lowGoal, clearGoal, stretchGoal);
};

/** Progress on the unified 0-100 scale shared with :func:`getMarkerPositions`. */
export const getProgressPercentage = (
  habit: Habit,
  currentGoal: Goal,
  tz: string = DEFAULT_TIMEZONE,
): number => {
  const todayProgress = calculateTodaysProgress(habit, tz);
  const stretchGoal = habit.goals.find((g) => g.tier === 'stretch') ?? currentGoal;
  const stretchTarget = getGoalTarget(stretchGoal);

  if (currentGoal.is_additive) {
    if (stretchTarget <= 0) return 100;
    return clampPercentage((todayProgress / stretchTarget) * 100);
  }

  const lowGoal = habit.goals.find((g) => g.tier === 'low') ?? currentGoal;
  const range = getGoalTarget(lowGoal) - stretchTarget;
  if (range <= 0) return todayProgress <= stretchTarget ? 100 : 0;
  return clampPercentage(100 - ((todayProgress - stretchTarget) / range) * 100);
};

/**
 * Progress-bar color for a habit: the stage color while the goal is
 * unmet, and a brighter shade of that same stage color once it is met.
 */
export const getProgressBarColor = (habit: Habit, tz: string = DEFAULT_TIMEZONE): string => {
  const stageColor = STAGE_COLORS[habit.stage] ?? '#000';
  const clearGoal = habit.goals.find((g) => g.tier === 'clear');

  if (!clearGoal) return stageColor;

  const todayProgress = calculateTodaysProgress(habit, tz);

  if (clearGoal.is_additive) {
    return todayProgress >= getGoalTarget(clearGoal) ? brightenColor(stageColor) : stageColor;
  }

  // Subtractive: victory when staying at or under stretch target
  const stretchGoal = habit.goals.find((g) => g.tier === 'stretch');
  if (stretchGoal && todayProgress <= getGoalTarget(stretchGoal)) {
    return brightenColor(stageColor);
  }

  return stageColor;
};

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_IN_WEEK = 7;

const emptyStats = (): HabitStatsData => ({
  dates: DAY_LABELS,
  values: new Array(DAYS_IN_WEEK).fill(0) as number[],
  completionsByDay: new Array(DAYS_IN_WEEK).fill(0) as number[],
  dayLabels: DAY_LABELS,
  longestStreak: 0,
  currentStreak: 0,
  totalCompletions: 0,
  completionRate: 0,
  completionDates: [],
});

/**
 * UTC day key kept for legacy call sites that have not yet threaded a TZ
 * parameter (e.g. `logHabitUnits`, `calculateMissedDays`).  These are
 * called from optimistic-update paths that operate on `Date` objects
 * that have no notion of user TZ; UTC bucketing matches the historical
 * behavior, and Wave 4 (frontend feature screens) will migrate them as
 * part of its `useOptimisticMutation` work.
 */
const utcDayKey = (d: Date): string => dayKeyInTZ(d, DEFAULT_TIMEZONE);

/**
 * Bucket completions into the user's local day (BUG-FE-HABIT-002).
 *
 * Uses `dayKeyInTZ` so a Sunday-night Pacific completion lands in
 * Sunday's bucket rather than Monday's (which is what UTC would say).
 * The day-of-week index is derived from the resolved local date so the
 * chart agrees with the user's perception, not the server's clock.
 */
const aggregateByDayOfWeek = (completions: Completion[], tz: string) => {
  const unitsByDay = new Array(DAYS_IN_WEEK).fill(0) as number[];
  const presenceByDay = new Array(DAYS_IN_WEEK).fill(0) as number[];
  const daysWithCompletions = new Set<string>();

  for (const c of completions) {
    const localDayKey = dayKeyInTZ(c.timestamp, tz);
    // Anchor at noon to avoid DST shoulder-day weekday skew.
    const localDate = new Date(`${localDayKey}T12:00:00Z`);
    const dayIdx = localDate.getUTCDay() % DAYS_IN_WEEK;
    unitsByDay[dayIdx] = unitsByDay[dayIdx]! + c.completed_units;
    presenceByDay[dayIdx] = 1;
    daysWithCompletions.add(localDayKey);
  }

  return { unitsByDay, presenceByDay, daysWithCompletions };
};

const computeLongestStreak = (sortedDays: Date[]): number => {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < sortedDays.length; i++) {
    const day = sortedDays[i]!;
    if (i === 0) {
      current = 1;
    } else {
      const prev = sortedDays[i - 1]!;
      const diff = (day.getTime() - prev.getTime()) / MS_PER_DAY;
      current = diff === 1 ? current + 1 : 1;
    }
    if (current > longest) longest = current;
  }
  return longest;
};

const computeCompletionRate = (sortedDays: Date[], totalUniqueDays: number): number => {
  if (sortedDays.length === 0) return 0;
  const firstDay = sortedDays[0]!;
  const lastDay = sortedDays[sortedDays.length - 1]!;
  const spanDays = Math.floor((lastDay.getTime() - firstDay.getTime()) / MS_PER_DAY) + 1;
  return spanDays > 0 ? totalUniqueDays / spanDays : 0;
};

/**
 * Wrap the centralized streak helper so this file's call sites keep their
 * existing signature.  The shared helper compares against "today" in the
 * user's TZ so a stale chain that ended a week ago no longer reports a
 * non-zero streak (BUG-FE-HABIT-207).
 */
const computeCurrentStreak = (completions: ReadonlyArray<Completion>, tz: string): number => {
  return streakFromCompletions(
    completions.map((c) => c.timestamp),
    tz,
  );
};

const collectCompletionDates = (sortedDays: Date[]): string[] =>
  sortedDays.filter((d) => !isNaN(d.getTime())).map((d) => d.toISOString().slice(0, 10));

/**
 * Compute real stats from a habit's completions array.
 *
 * Day-of-week indices: 0=Sun, 1=Mon, … 6=Sat (matching JS `getDay()`).
 *
 * `tz` selects the calendar used for day-of-week buckets and streak
 * computation (BUG-FE-HABIT-002 / -207).  Defaults to UTC for legacy
 * callers; screens reading from the auth context should pass
 * `user.timezone`.
 */
export const generateStatsForHabit = (
  habit: Habit,
  tz: string = DEFAULT_TIMEZONE,
): HabitStatsData => {
  const completions = habit.completions;
  if (!completions || completions.length === 0) return emptyStats();

  const { unitsByDay, presenceByDay, daysWithCompletions } = aggregateByDayOfWeek(completions, tz);

  const sortedDays = Array.from(daysWithCompletions)
    .map((s) => new Date(s + 'T00:00:00Z'))
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    dates: DAY_LABELS,
    values: unitsByDay,
    completionsByDay: presenceByDay,
    dayLabels: DAY_LABELS,
    longestStreak: computeLongestStreak(sortedDays),
    currentStreak: computeCurrentStreak(completions, tz),
    totalCompletions: completions.length,
    completionRate: computeCompletionRate(sortedDays, daysWithCompletions.size),
    completionDates: collectCompletionDates(sortedDays),
  };
};

/**
 * Convert an API habit stats response (snake_case) to local HabitStatsData (camelCase).
 */
export const toLocalHabitStats = (api: ApiHabitStats): HabitStatsData => ({
  dates: api.day_labels,
  values: api.values,
  completionsByDay: api.completions_by_day,
  dayLabels: api.day_labels,
  longestStreak: api.longest_streak,
  currentStreak: api.current_streak,
  totalCompletions: api.total_completions,
  completionRate: api.completion_rate,
  completionDates: api.completion_dates,
});

/**
 * Calculate days without completions between the first and last completion.
 */
export const calculateMissedDays = (habit: Habit): Date[] => {
  const completions = habit.completions;
  if (!completions || completions.length === 0) return [];

  const completedDates = new Set<string>();
  for (const c of completions) {
    completedDates.add(utcDayKey(new Date(c.timestamp)));
  }

  const sorted = Array.from(completedDates)
    .map((s) => new Date(s + 'T00:00:00Z'))
    .sort((a, b) => a.getTime() - b.getTime());

  if (sorted.length < 2) return [];

  const missed: Date[] = [];
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const cursor = new Date(first);
  cursor.setDate(cursor.getDate() + 1);

  while (cursor < last) {
    if (!completedDates.has(utcDayKey(cursor))) {
      missed.push(new Date(cursor));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return missed;
};

// Logs a number of units for the given habit. Multiple logs can occur within
// the same day; however, the streak counter will only increment once per
// calendar day. Returns the updated habit object.
export const logHabitUnits = (habit: Habit, amount: number, date: Date = new Date()): Habit => {
  const alreadyLoggedToday =
    habit.last_completion_date &&
    utcDayKey(new Date(habit.last_completion_date)) === utcDayKey(date);

  const completion: Completion = {
    id: uuidv4(),
    timestamp: date,
    completed_units: amount,
  };

  return {
    ...habit,
    streak: alreadyLoggedToday ? habit.streak : habit.streak + 1,
    last_completion_date: date,
    completions: habit.completions ? [...habit.completions, completion] : [completion],
  };
};

export const calculateNetEnergy = (cost: number, returnValue: number): number => {
  return returnValue - cost;
};

/** A habit is "early unlocked" if it has been manually revealed before its start_date. */
export const isEarlyUnlocked = (habit: Habit): boolean => {
  return habit.revealed === true && new Date(habit.start_date).getTime() > Date.now();
};
