/**
 * Checking off the linked habit when a writing session ends (#2861).
 *
 * The writer may link the writing timer to a habit they already keep — by
 * whatever name — or to a new "Journaling" one. After that, every finished
 * session checks the habit off.
 *
 * **The amount** is the shared session-credit rule
 * (``features/Habits/sessionCredit``), read off the habit's LOW tier unit: a
 * habit measured in minutes is credited the session's own minutes, which
 * accumulate on the server (two ten-minute sessions make twenty); a habit
 * counted in sessions, reps or times is credited one per session; any other
 * unit (pages, oz, …) is credited the gap to today's LOW target, and nothing
 * once that is met. ``isLinkableHabit`` — server-backed, unlocked, not a demo
 * tile, not subtractive, with the full tier ladder — gates both the picker and
 * the check-off, so a linked habit that locks later simply goes quiet until it
 * is open again.
 *
 * **The posting** is ``creditLinkedHabit``'s: the habits are re-read from the
 * server first, the log goes through the ``habitManager`` logUnit pipeline, and
 * every failure is quiet (a ``console.warn``, a rolled-back row, no modal, no
 * milestone toast — success says only "<Name> checked off").
 *
 * **Which sessions.** Any session that ran at all — ``elapsedMs`` of at least
 * ``MIN_CHECK_OFF_ELAPSED_MS`` — including one the writer stopped early: they
 * sat down and wrote, and that is what the habit is for. A session stopped at
 * zero wrote nothing and checks nothing off. (A minute habit additionally
 * needs the session to have rounded to a whole minute; that is the credit
 * rule's, not this gate's.)
 */
import { checkedOffToast } from './saveAsHabitCopy';

import type { ToastConfig } from '@/components/Toast';
import { creditLinkedHabit } from '@/features/Habits/creditLinkedHabit';

export { isLinkableHabit } from '@/features/Habits/sessionCredit';

/** A session shorter than this wrote nothing, and checks nothing off. */
export const MIN_CHECK_OFF_ELAPSED_MS = 1;

const LOG_TAG = 'writingHabitCheckOff';

export interface CheckOffRequest {
  /** The linked habit, as stored on ``/ui-flags``. */
  habitId: number;
  /** How long the session ran; see ``MIN_CHECK_OFF_ELAPSED_MS``. */
  elapsedMs: number;
  /** The same, to the nearest whole minute — what a minute habit is credited. */
  elapsedMinutes: number;
  /** The account zone the day is counted in. */
  tz: string;
  /** Where the one-line confirmation goes. */
  showToast: (_config: ToastConfig) => void;
  /** The clock the check-in is dated by; tests inject it. */
  now?: () => Date;
}

/**
 * Check off the linked habit for one finished session. Never throws: every
 * failure ends in a ``console.warn`` and an unchanged store.
 */
export async function checkOffLinkedHabit(request: CheckOffRequest): Promise<void> {
  if (request.elapsedMs < MIN_CHECK_OFF_ELAPSED_MS) return;
  await creditLinkedHabit({
    habitId: request.habitId,
    elapsedMinutes: request.elapsedMinutes,
    tz: request.tz,
    showToast: request.showToast,
    now: request.now,
    toast: checkedOffToast,
    logTag: LOG_TAG,
  });
}
