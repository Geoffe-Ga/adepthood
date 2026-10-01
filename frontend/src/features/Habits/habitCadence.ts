import type { PeriodCadence, PeriodUnit } from '../../utils/dateUtils';

import type { Goal } from './Habits.types';

/**
 * How often a habit is judged. Daily habits are judged every day against
 * `goal.target`; weekly and monthly habits are judged per period, needing
 * `daysNeeded` done days (each reaching `dayTarget`) for the period to count.
 */
export type HabitCadence = { unit: 'day' } | PeriodCadence;

/** The daily cadence — the default whenever a goal set cannot say otherwise. */
export const DAY_CADENCE: HabitCadence = { unit: 'day' };

/** `frequency_unit` values that name a period longer than a day. */
const PERIOD_UNITS: Readonly<Record<string, PeriodUnit>> = {
  per_week: 'week',
  per_month: 'month',
};

/** A period always needs at least one done day; an empty requirement is not a goal. */
const MIN_DAYS_NEEDED = 1;

/**
 * Read a habit's cadence from its LOW tier — the floor the user committed to.
 *
 * `goal.target` is always the per-day amount, in every cadence, and
 * `goal.frequency` is how many done days the period needs (rounded up to a
 * whole day, never below one). A missing low tier or a `frequency_unit`
 * that names no period (`per_day`, `per_session`, anything unknown) is daily.
 */
export const habitCadence = (
  goals: ReadonlyArray<Pick<Goal, 'tier' | 'target' | 'frequency' | 'frequency_unit'>>,
): HabitCadence => {
  const low = goals.find((goal) => goal.tier === 'low');
  if (!low) return DAY_CADENCE;
  const unit = PERIOD_UNITS[low.frequency_unit];
  if (unit === undefined) return DAY_CADENCE;
  const wholeDays = Number.isFinite(low.frequency) ? Math.ceil(low.frequency) : MIN_DAYS_NEEDED;
  return { unit, daysNeeded: Math.max(MIN_DAYS_NEEDED, wholeDays), dayTarget: low.target };
};
