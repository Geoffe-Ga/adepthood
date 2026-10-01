/**
 * Credit the habit linked to a session timer, once a session has finished.
 *
 * The posting half of the link, shared by the writing timer
 * (``writingHabitCheckOff``) and practice sessions (``practiceHabitCheckOff``);
 * the amount is ``planSessionCredit``'s. It goes through the same
 * ``habitManager`` logUnit pipeline the Habits screen uses (prepare → apply →
 * commit → reconcile, or rollback), so there is exactly one path to
 * ``POST /goal_completions/``.
 *
 * **Server truth.** The habits are re-read (``GET /habits/``) before every
 * credit, so a gap-to-low amount is measured against the server's day and not
 * this device's possibly stale copy — a second device may have checked the
 * habit off since. A failed read posts nothing: one missed credit is the
 * smaller harm.
 *
 * **Quiet on failure.** The person is on the page they were writing or
 * sitting on. A failed post rolls the optimistic row back and
 * ``console.warn``s; it never raises, never opens a modal, and never shows a
 * milestone or streak toast — success says only what the caller's ``toast``
 * says, which is "<Name> checked off".
 */
import type { Habit } from './Habits.types';
import { habitManager } from './services/habitManager';
import { planSessionCredit } from './sessionCredit';

import type { ToastConfig } from '@/components/Toast';
import { colors } from '@/design/tokens';
import { useHabitStore } from '@/store/useHabitStore';

export interface LinkedHabitCreditRequest {
  /** The linked habit, as stored on ``/ui-flags``. */
  habitId: number;
  /** How long the session ran, to the nearest whole minute. */
  elapsedMinutes: number;
  /** The account zone the day is counted in. */
  tz: string;
  /** Where the one-line confirmation goes. */
  showToast: (_config: ToastConfig) => void;
  /** The confirmation's words, given the habit's name. */
  toast: (_habitName: string) => string;
  /** Who is logging, for the warning line. */
  logTag: string;
  /** The clock the check-in is dated by; tests inject it. */
  now?: () => Date;
}

const systemClock = (): Date => new Date();

const findHabit = (habitId: number): Habit | undefined =>
  useHabitStore.getState().habits.find((habit) => habit.id === habitId);

/**
 * The linked habit AS THE SERVER HAS IT NOW, or ``undefined`` when that cannot
 * be known. ``refreshHabits`` is the same ``GET /habits/`` the Habits screen
 * hydrates from, and says whether the server actually answered (a cached list
 * stays on screen either way).
 */
async function resolveLinkedHabit(habitId: number, tz: string): Promise<Habit | undefined> {
  const fresh = await habitManager.refreshHabits(tz);
  return fresh ? findHabit(habitId) : undefined;
}

/** Post ``amount`` against the habit through the logUnit pipeline, quietly. */
async function commitCredit(
  habit: Habit,
  amount: number,
  { tz, showToast, toast, logTag, now = systemClock }: LinkedHabitCreditRequest,
): Promise<void> {
  const ctx = habitManager.prepareLogUnit(habit.id, amount, tz, now());
  if (!ctx) return;
  habitManager.applyLogUnitContext(ctx);
  try {
    const result = await habitManager.commitLogUnitContext(ctx);
    if (!result) return;
    habitManager.reconcileLogUnitContext(ctx, result);
    showToast({ message: toast(ctx.habitName), color: colors.success });
  } catch (err) {
    habitManager.rollbackLogUnitContext(ctx);
    console.warn(`[${logTag}] failed to check off the linked habit`, err);
  }
}

/**
 * Credit the linked habit for one finished session. Never throws: every
 * failure ends in a ``console.warn`` and an unchanged store.
 */
export async function creditLinkedHabit(request: LinkedHabitCreditRequest): Promise<void> {
  try {
    const habit = await resolveLinkedHabit(request.habitId, request.tz);
    if (!habit) return;
    const amount = planSessionCredit(habit, { elapsedMinutes: request.elapsedMinutes }, request.tz);
    if (amount === null) return;
    await commitCredit(habit, amount, request);
  } catch (err) {
    console.warn(`[${request.logTag}] could not reach the linked habit`, err);
  }
}
