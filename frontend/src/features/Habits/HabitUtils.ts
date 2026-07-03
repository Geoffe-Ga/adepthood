import { v4 as uuidv4 } from 'uuid';

import type { ApiHabitStats } from '../../api';
import { STAGE_DURATIONS_DAYS } from '../../constants/program';
import { brightenColor, colors, STAGE_COLORS, STAGE_ORDER } from '../../design/tokens';
import {
  DEFAULT_TIMEZONE,
  MS_PER_DAY,
  dayKeyInTZ,
  streakFromCompletions,
  subtractiveLongestStreakFromCompletions,
  subtractiveStreakFromCompletions,
  todayInUserTZ,
} from '../../utils/dateUtils';

import type { Goal, Habit, Completion, HabitStatsData } from './Habits.types';

export { STAGE_ORDER };
// Re-export so existing call sites stay valid; canonical definition lives in src/constants/program.ts.
export { STAGE_DURATIONS_DAYS };

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
  // A habit is subtractive iff ANY of its goals is non-additive — the same rule
  // the backend's _subtractive_context uses, so the "Achieved" badge and the
  // server-computed streak can never disagree (#768). Probing a single tier let
  // them diverge when the tiers were not perfectly consistent.
  const isSubtractive = habit.goals.some((g) => !g.is_additive);
  return isSubtractive
    ? resolveSubtractiveTier(todayProgress, lowGoal, clearGoal, stretchGoal)
    : resolveAdditiveTier(todayProgress, lowGoal, clearGoal, stretchGoal);
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
 *
 * The tile renders its border from a position-derived color (see
 * ``HabitsScreen.renderHabitTile``) because ``habit.stage`` defaults to
 * an empty string on the backend. Callers that already resolved that
 * tile color should pass it via ``stageColorOverride`` so the bar
 * matches the border instead of collapsing to the black fallback.
 */
export const getProgressBarColor = (
  habit: Habit,
  tz: string = DEFAULT_TIMEZONE,
  stageColorOverride?: string,
): string => {
  const stageColor = stageColorOverride ?? STAGE_COLORS[habit.stage] ?? '#000';
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
  const countsByDay = new Array(DAYS_IN_WEEK).fill(0) as number[];
  const daysWithCompletions = new Set<string>();

  for (const c of completions) {
    const localDayKey = dayKeyInTZ(c.timestamp, tz);
    // Anchor at noon to avoid DST shoulder-day weekday skew.
    const localDate = new Date(`${localDayKey}T12:00:00Z`);
    const dayIdx = localDate.getUTCDay() % DAYS_IN_WEEK;
    unitsByDay[dayIdx] = unitsByDay[dayIdx]! + c.completed_units;
    countsByDay[dayIdx] = countsByDay[dayIdx]! + 1;
    daysWithCompletions.add(localDayKey);
  }

  return { unitsByDay, countsByDay, daysWithCompletions };
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
 * Subtractive habits (e.g. "abstain from sugar") count *no-log* days as
 * abstention successes, so the additive helper — which requires a row
 * per counted day — is wrong for them.  Returns `null` when the habit
 * is additive or lacks the clear-tier sibling to read the threshold
 * from, falling back to the additive code path.
 *
 * Subtractive iff **any** goal is non-additive — the single polarity rule
 * shared with ``getGoalTier`` (the badge) and the backend
 * ``_subtractive_context`` (BUG #768): probing one specific tier let the two
 * disagree, so a never-logged abstention habit reported a ``0`` streak while
 * the badge said "Achieved". The threshold comes from the ``clear``-tier goal,
 * or the first non-additive goal if the clear tier is absent.
 */
const subtractiveStreakInputs = (
  habit: Habit,
  tz: string,
): { clearThreshold: number; startDate: string } | null => {
  const nonAdditive = habit.goals.filter((g) => !g.is_additive);
  if (nonAdditive.length === 0) return null;
  const thresholdGoal = habit.goals.find((g) => g.tier === 'clear') ?? nonAdditive[0]!;
  return {
    clearThreshold: getGoalTarget(thresholdGoal),
    startDate: dayKeyInTZ(habit.start_date, tz),
  };
};

/**
 * Wrap the centralized streak helper so this file's call sites keep their
 * existing signature.  The shared helper compares against "today" in the
 * user's TZ so a stale chain that ended a week ago no longer reports a
 * non-zero streak (BUG-FE-HABIT-207).
 *
 * For subtractive habits, delegates to the abstention-aware helper so a
 * habit with no log entries still accrues streak days — the user has
 * stayed clean since `habit.start_date`.
 */
const computeCurrentStreak = (
  habit: Habit,
  completions: ReadonlyArray<Completion>,
  tz: string,
): number => {
  const subtractive = subtractiveStreakInputs(habit, tz);
  if (subtractive) {
    return subtractiveStreakFromCompletions(
      {
        completions: completions.map((c) => ({
          timestamp: c.timestamp,
          completed_units: c.completed_units,
        })),
        clearThreshold: subtractive.clearThreshold,
        startDate: subtractive.startDate,
      },
      tz,
    );
  }
  return streakFromCompletions(
    completions.map((c) => c.timestamp),
    tz,
  );
};

/**
 * Longest streak across the habit's life — subtractive-aware.
 *
 * For additive habits, defers to the existing
 * :func:`computeLongestStreak` which counts consecutive logged days.
 * For subtractive habits, walks ``[start_date, today]`` and tracks the
 * longest no-transgression run; without this the stats overlay shows
 * a contradictory "Current: 7 · Longest: 0" pair for any habit whose
 * current streak is non-zero but has no log entries (the
 * ``computeLongestStreak`` input is empty in that case).
 */
const computeLongestStreakFor = (
  habit: Habit,
  completions: ReadonlyArray<Completion>,
  sortedDays: Date[],
  tz: string,
): number => {
  const subtractive = subtractiveStreakInputs(habit, tz);
  if (subtractive) {
    return subtractiveLongestStreakFromCompletions(
      {
        completions: completions.map((c) => ({
          timestamp: c.timestamp,
          completed_units: c.completed_units,
        })),
        clearThreshold: subtractive.clearThreshold,
        startDate: subtractive.startDate,
      },
      tz,
    );
  }
  return computeLongestStreak(sortedDays);
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
  const rawCompletions = habit.completions;
  // Subtractive habits accrue a streak even with zero rows — abstaining every
  // day since `start_date` is the success case, not the no-data case — so
  // emptyStats() would zero out an active abstention chain.
  const emptyStreakStats = (): HabitStatsData => ({
    ...emptyStats(),
    currentStreak: computeCurrentStreak(habit, [], tz),
    longestStreak: computeLongestStreakFor(habit, [], [], tz),
  });
  if (!rawCompletions || rawCompletions.length === 0) {
    return emptyStreakStats();
  }

  // Additive habits: a persisted "did not complete" (`completed_units == 0`)
  // row is ignored like an absent day across every stat field — matching the
  // backend owner `_additive_stats`, which filters once at entry so buckets,
  // streaks, rate, and total all describe actual completions. Subtractive
  // habits keep those rows — a zero-log day is an abstention win, not a gap.
  const isSubtractive = subtractiveStreakInputs(habit, tz) !== null;
  const completions = isSubtractive
    ? rawCompletions
    : rawCompletions.filter((c) => c.completed_units > 0);
  if (completions.length === 0) {
    return emptyStreakStats();
  }

  const { unitsByDay, countsByDay, daysWithCompletions } = aggregateByDayOfWeek(completions, tz);

  const sortedDays = Array.from(daysWithCompletions)
    .map((s) => new Date(s + 'T00:00:00Z'))
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    values: unitsByDay,
    completionsByDay: countsByDay,
    dayLabels: DAY_LABELS,
    longestStreak: computeLongestStreakFor(habit, completions, sortedDays, tz),
    currentStreak: computeCurrentStreak(habit, completions, tz),
    totalCompletions: completions.length,
    completionRate: computeCompletionRate(sortedDays, daysWithCompletions.size),
    completionDates: collectCompletionDates(sortedDays),
  };
};

/**
 * Convert an API habit stats response (snake_case) to local HabitStatsData (camelCase).
 */
export const toLocalHabitStats = (api: ApiHabitStats): HabitStatsData => ({
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

/** Locked today iff unrevealed AND its calendar-anchored `start_date` is still in the future; once that date arrives the habit unlocks regardless of a stale `revealed` flag (which only gates manual early-unlock). */
export const isHabitLockedToday = (habit: Habit, now: number = Date.now()): boolean => {
  return habit.revealed === false && new Date(habit.start_date).getTime() > now;
};
