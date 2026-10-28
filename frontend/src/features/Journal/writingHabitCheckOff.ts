/**
 * Log the amount a writing timer measured through the shared habit mutation
 * pipeline. A second session adds its own amount; transport retries preserve
 * the operation identity. Minutes include early stops; a sessions habit counts
 * only a full session. Current server eligibility is read before posting.
 * Failure keeps the writing session intact and never claims a successful log.
 */
import { loggedToast } from './saveAsHabitCopy';
import type { WritingSessionResult } from './writingSession';

import type { ToastConfig } from '@/components/Toast';
import { colors } from '@/design/tokens';
import type { Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { isTimerLinkableHabit as isLinkableHabit } from '@/features/Habits/timerHabit';
export {
  canConfigureTimerHabit as canConfigureWritingHabit,
  isTimerLinkableHabit as isLinkableHabit,
} from '@/features/Habits/timerHabit';
import { reportDiagnostic } from '@/observability/diagnostics';
import { getActiveUserGeneration } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';

/** A session shorter than this wrote nothing, and checks nothing off. */
export const MIN_CHECK_OFF_ELAPSED_MS = 1;

/** The amount measured by this session, independent of the day's previous logs. */
export function planTimerLog(habit: Habit, result: WritingSessionResult): number | null {
  if (!isLinkableHabit(habit) || result.elapsedMs <= 0) return null;
  const unit = habit.goals[0]?.target_unit;
  if (!habit.goals.every((goal) => goal.target_unit === unit)) return null;
  if (unit === 'minutes') return Math.max(1, result.elapsedMinutes);
  return unit === 'sessions' && result.reachedFullDuration ? 1 : null;
}

export interface CheckOffRequest {
  /** The linked habit, as stored on ``/ui-flags``. */
  habitId: number;
  /** How long the session ran; see ``MIN_CHECK_OFF_ELAPSED_MS``. */
  result: WritingSessionResult;
  onLogged?: (_message: string) => void;
  /** The initiating screen/account/link still owns this result. */
  isCurrent?: () => boolean;
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
 * Re-read eligibility before adding this session's measured amount. A cached
 * habit may have been deleted, locked, or changed to an unsupported unit.
 * ``refreshHabits`` reports whether the server answered; an unsuccessful read
 * leaves the cache visible but does not authorize a timed log.
 */
async function resolveLinkedHabit(habitId: number, tz: string): Promise<Habit | undefined> {
  const fresh = await habitManager.refreshHabits(tz);
  return fresh ? findHabit(habitId) : undefined;
}

/** Post ``amount`` against the habit through the logUnit pipeline, quietly. */
async function commitCheckOff(
  habit: Habit,
  amount: number,
  { tz, showToast, onLogged, now = systemClock }: CheckOffRequest,
  isCurrent: () => boolean,
  ownsStore: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const ctx = habitManager.prepareLogUnit(habit.id, amount, tz, now());
  if (!ctx) return;
  habitManager.reserveLogUnitContext(ctx);
  try {
    const result = await habitManager.commitLogUnitContext(ctx, {
      viaTimer: true,
      isCurrent,
      onCommitted: (confirmed) => {
        if (ownsStore()) habitManager.reconcileReservedLogUnitContext(ctx, confirmed);
      },
    });
    if (!result || !isCurrent()) return;
    const message = loggedToast(amount, habit.goals[0]!.target_unit, ctx.habitName);
    showToast({ message, color: colors.success });
    onLogged?.(message);
  } catch {
    reportDiagnostic('linked_habit_failed');
  } finally {
    habitManager.discardLogUnitContext(ctx);
  }
}

/**
 * Add one session's measured amount. Failures report a fixed diagnostic and
 * preserve confirmed habit state; confirmation appears only after success.
 */
export async function checkOffLinkedHabit(request: CheckOffRequest): Promise<void> {
  if (request.result.elapsedMs < MIN_CHECK_OFF_ELAPSED_MS) return;
  const ownerGeneration = getActiveUserGeneration();
  const ownsStore = () => getActiveUserGeneration() === ownerGeneration;
  const isCurrent = () => ownsStore() && (request.isCurrent?.() ?? true);
  try {
    const habit = await resolveLinkedHabit(request.habitId, request.tz);
    if (!habit || !isCurrent()) return;
    const amount = planTimerLog(habit, request.result);
    if (amount === null) return;
    await commitCheckOff(habit, amount, request, isCurrent, ownsStore);
  } catch {
    reportDiagnostic('linked_habit_failed');
  }
}
