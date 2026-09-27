/**
 * Checking off the linked habit when a writing session ends (#2861).
 *
 * The writer may link the writing timer to a habit they already keep — by
 * whatever name — or to a new "Journaling" one. After that, every finished
 * session checks the habit off. This module decides what "checks off" means
 * and does it, through the same ``habitManager`` logUnit pipeline the Habits
 * screen uses (prepare → apply → commit → reconcile, or rollback), so there is
 * exactly one path to ``POST /goal_completions/``.
 *
 * **The amount.** Since #2852 an explicit ``completed_units`` ACCUMULATES on
 * the server: two posts of five minutes are ten, not five. So idempotency
 * cannot be left to the server, and posting the session's elapsed minutes
 * would push the habit further on every session. "Checked off" is therefore
 * defined as *the LOW tier target is met today*, and the amount posted is the
 * gap to it — ``computeStarFillPlan(habit, 'low', tz).deltaUnits``, the same
 * gap rule the star long-press uses, with its float-dust guard. When the gap
 * is not positive the habit is already checked off and nothing is posted, so a
 * second session the same day (or a double-fired finish) cannot double-count.
 *
 * **Which habits.** Only ones this rule can honestly apply to: server-backed
 * ids (a PATCH and a post need real rows), UNLOCKED (``revealed``: the Habits
 * screen offers no logging on a locked habit — not begun yet, re-locked, or
 * released by a Metta Return — and this must not be a back door past that),
 * not a demo tile, not subtractive (a "check-off" there would record
 * consumption), and with all three tiers (the rule is defined against the
 * ladder). ``isLinkableHabit`` gates both the picker and the check-off, so a
 * linked habit that locks later simply goes quiet until it is open again.
 *
 * **Server truth.** The habits are re-read (``GET /habits/``) before every
 * check-off, so the gap is the server's, not this device's possibly stale
 * copy's; a failed read posts nothing.
 *
 * **Which sessions.** Any session that ran at all — ``elapsedMs`` of at least
 * ``MIN_CHECK_OFF_ELAPSED_MS`` — including one the writer stopped early: they
 * sat down and wrote, and that is what the habit is for. A session stopped at
 * zero wrote nothing and checks nothing off.
 *
 * **Quiet on failure.** The writer is on the page they are writing on. A
 * failed post rolls the optimistic row back and ``console.warn``s; it never
 * raises, never opens a modal, and never shows a milestone or streak toast —
 * success says only "<Name> checked off".
 */
import { checkedOffToast } from './saveAsHabitCopy';

import type { ToastConfig } from '@/components/Toast';
import { colors } from '@/design/tokens';
import type { Habit } from '@/features/Habits/Habits.types';
import { isHabitUnlocked, isSubtractiveHabit } from '@/features/Habits/HabitUtils';
import { habitManager } from '@/features/Habits/services/habitManager';
import {
  hasServerIssuedIds,
  isNotDemoSeed,
  isServerIssuedId,
} from '@/features/Habits/services/serverIds';
import { computeStarFillPlan } from '@/features/Habits/starFill';
import { useHabitStore } from '@/store/useHabitStore';

/** A session shorter than this wrote nothing, and checks nothing off. */
export const MIN_CHECK_OFF_ELAPSED_MS = 1;

/** The tiers the check-off rule is defined against; all three must exist. */
const LADDER_TIERS = ['low', 'clear', 'stretch'] as const;

/** Whether a habit can be linked to the writing timer, and checked off by it. */
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

/**
 * The units a finished session posts: the gap to today's LOW target, or
 * ``null`` when the habit is already checked off (or cannot be linked).
 */
export function planWritingCheckOff(habit: Habit, tz: string): number | null {
  if (!isLinkableHabit(habit)) return null;
  const plan = computeStarFillPlan(habit, 'low', tz);
  if (plan === null || plan.deltaUnits <= 0) return null;
  return plan.deltaUnits;
}

export interface CheckOffRequest {
  /** The linked habit, as stored on ``/ui-flags``. */
  habitId: number;
  /** How long the session ran; see ``MIN_CHECK_OFF_ELAPSED_MS``. */
  elapsedMs: number;
  /** The account zone the day is counted in. */
  tz: string;
  /** Where the one-line confirmation goes. */
  showToast: (_config: ToastConfig) => void;
  /** The clock the check-in is dated by; tests inject it. */
  now?: () => Date;
}

const systemClock = (): Date => new Date();

const findHabit = (habitId: number): Habit | undefined =>
  useHabitStore.getState().habits.find((habit) => habit.id === habitId);

/**
 * The linked habit AS THE SERVER HAS IT NOW, or ``undefined`` when that cannot
 * be known.
 *
 * The habits are always re-read before posting, never taken from the store as
 * it stands: the gap is only idempotent if it is measured against the server's
 * day, and this device's store can be minutes stale — a second device may have
 * checked the habit off since. The read is the same ``GET /habits/`` the Habits
 * screen hydrates from, through ``refreshHabits``, which says whether the
 * server actually answered (a cached list stays on screen either way). When it
 * did not, nothing is posted: a check-off computed from a stale day could
 * double-count, and one missed check-off is the smaller harm.
 */
async function resolveLinkedHabit(habitId: number, tz: string): Promise<Habit | undefined> {
  const fresh = await habitManager.refreshHabits(tz);
  return fresh ? findHabit(habitId) : undefined;
}

/** Post ``amount`` against the habit through the logUnit pipeline, quietly. */
async function commitCheckOff(
  habit: Habit,
  amount: number,
  { tz, showToast, now = systemClock }: CheckOffRequest,
): Promise<void> {
  const ctx = habitManager.prepareLogUnit(habit.id, amount, tz, now());
  if (!ctx) return;
  habitManager.applyLogUnitContext(ctx);
  try {
    const result = await habitManager.commitLogUnitContext(ctx);
    if (!result) return;
    habitManager.reconcileLogUnitContext(ctx, result);
    showToast({ message: checkedOffToast(ctx.habitName), color: colors.success });
  } catch (err) {
    habitManager.rollbackLogUnitContext(ctx);
    console.warn('[writingHabitCheckOff] failed to check off the linked habit', err);
  }
}

/**
 * Check off the linked habit for one finished session. Never throws: every
 * failure ends in a ``console.warn`` and an unchanged store.
 */
export async function checkOffLinkedHabit(request: CheckOffRequest): Promise<void> {
  if (request.elapsedMs < MIN_CHECK_OFF_ELAPSED_MS) return;
  try {
    const habit = await resolveLinkedHabit(request.habitId, request.tz);
    if (!habit) return;
    const amount = planWritingCheckOff(habit, request.tz);
    if (amount === null) return;
    await commitCheckOff(habit, amount, request);
  } catch (err) {
    console.warn('[writingHabitCheckOff] could not reach the linked habit', err);
  }
}
