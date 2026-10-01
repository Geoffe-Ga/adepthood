/**
 * How much a finished timed session credits the habit linked to it.
 *
 * One rule, shared by the writing timer (#2861) and practice sessions, so the
 * two cannot drift on what a "check-off" is worth. Everything here is pure —
 * the habit as read from the server, the session's length, the account zone —
 * and the posting lives with each caller.
 *
 * **The amount is read off the LOW tier's unit** (``target_unit``, trimmed and
 * lower-cased), because the unit is the habit's own statement of what it
 * counts:
 *
 * - **Minutes** (``SESSION_UNIT_GROUPS.min``): the session's own minutes, as
 *   already rounded by the session module. A habit measured in minutes is
 *   asking for time, and a twenty-minute session is twenty of them — not the
 *   gap to the lowest target, which once left a writer who sat for twenty
 *   minutes credited with ten. The server ACCUMULATES explicit units (#2852),
 *   so two ten-minute sessions make twenty; that is the intent. A session
 *   that rounded to nothing credits nothing.
 * - **Counts** (``count``, ``rep``, ``session`` groups): one per session, so a
 *   "3 times a day" habit goes 0 → 1 → 2 → 3 across three sessions.
 * - **Anything else** (oz, pages, hours, …): there is no honest conversion
 *   from minutes, so the session is taken as "the habit was done today": the
 *   gap to the LOW target (``computeStarFillPlan``'s own gap rule, with its
 *   float-dust guard), and nothing once that target is met — which is also
 *   what keeps a second session the same day from double-counting here.
 *
 * The unit groups mirror ``backend/src/domain/detection_facts.py``'s
 * ``_UNIT_GROUPS`` by name, so the two sides agree on what "min" or "x" means.
 *
 * **Which habits.** Only ones a credit can honestly apply to
 * (``isLinkableHabit``): server-issued ids (a post needs a real row), UNLOCKED
 * (``revealed``: the Habits screen offers no logging on a locked habit and this
 * must not be a back door past that), not a demo tile, not subtractive (a
 * "check-off" there would record consumption), and with all three tiers (the
 * rule is defined against the ladder). The same predicate gates the pickers,
 * so a linked habit that locks later simply goes quiet until it is open again.
 */
import type { Habit } from './Habits.types';
import { isHabitUnlocked, isSubtractiveHabit } from './HabitUtils';
import { hasServerIssuedIds, isNotDemoSeed, isServerIssuedId } from './services/serverIds';
import { computeStarFillPlan } from './starFill';

/** The tiers the credit rule is defined against; all three must exist. */
export const LADDER_TIERS = ['low', 'clear', 'stretch'] as const;

/**
 * The unit spellings a session can be converted into, grouped as the backend
 * groups them (``detection_facts._UNIT_GROUPS``). Only the groups a session
 * has a meaning for are listed: minutes are its length, and counts, reps and
 * sessions are "it happened once".
 */
export const SESSION_UNIT_GROUPS = {
  min: ['min', 'mins', 'minute', 'minutes'],
  count: ['unit', 'units', 'time', 'times', 'x'],
  rep: ['rep', 'reps'],
  session: ['session', 'sessions'],
} as const;

const MINUTE_UNITS: ReadonlySet<string> = new Set(SESSION_UNIT_GROUPS.min);

const COUNT_UNITS: ReadonlySet<string> = new Set([
  ...SESSION_UNIT_GROUPS.count,
  ...SESSION_UNIT_GROUPS.rep,
  ...SESSION_UNIT_GROUPS.session,
]);

/** A minute habit is credited only by a session that rounded to at least this. */
export const MIN_MINUTE_CREDIT = 1;

/** What one session is worth to a habit counted in sessions, reps or times. */
export const SESSION_COUNT_CREDIT = 1;

/** The facts about a finished session the credit rule needs. */
export interface SessionFacts {
  /** How long it ran, already rounded to the nearest whole minute. */
  readonly elapsedMinutes: number;
}

/** Whether a habit can be linked to a session timer, and credited by one. */
export function isLinkableHabit(habit: Habit): boolean {
  return (
    isServerIssuedId(habit.id) &&
    hasServerIssuedIds(habit) &&
    isHabitUnlocked(habit) &&
    isNotDemoSeed(habit) &&
    !isSubtractiveHabit(habit) &&
    LADDER_TIERS.every((tier) => habit.goals.some((goal) => goal.tier === tier))
  );
}

/** The LOW tier's unit as the rule reads it: trimmed, lower-cased, '' when absent. */
function lowTierUnit(habit: Habit): string {
  const low = habit.goals.find((goal) => goal.tier === 'low');
  return (low?.target_unit ?? '').trim().toLowerCase();
}

/** The gap to today's LOW target, or ``null`` once it is met. */
function gapToLowTarget(habit: Habit, tz: string): number | null {
  const plan = computeStarFillPlan(habit, 'low', tz);
  if (plan === null || plan.deltaUnits <= 0) return null;
  return plan.deltaUnits;
}

/**
 * The units one finished session credits ``habit`` with, or ``null`` when it
 * credits nothing: the habit cannot be linked, a minute habit saw no whole
 * minute, or a habit in some other unit is already checked off today.
 */
export function planSessionCredit(
  habit: Habit,
  { elapsedMinutes }: SessionFacts,
  tz: string,
): number | null {
  if (!isLinkableHabit(habit)) return null;
  const unit = lowTierUnit(habit);
  if (MINUTE_UNITS.has(unit)) {
    return Number.isFinite(elapsedMinutes) && elapsedMinutes >= MIN_MINUTE_CREDIT
      ? elapsedMinutes
      : null;
  }
  if (COUNT_UNITS.has(unit)) return SESSION_COUNT_CREDIT;
  return gapToLowTarget(habit, tz);
}
