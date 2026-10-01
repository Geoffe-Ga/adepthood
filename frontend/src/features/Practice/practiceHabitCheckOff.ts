/**
 * Checking off the linked habit when a practice session is saved.
 *
 * The practice-side twin of ``writingHabitCheckOff`` (#2861). The person may
 * link practice sessions to a habit they already keep (Settings → Practice);
 * after that, every saved session — the ritual timer's, the manual log's, or
 * a quick-launched journal page's — checks the habit off.
 *
 * **The amount** is the shared session-credit rule
 * (``features/Habits/sessionCredit``): a habit in minutes is credited the
 * session's minutes (which accumulate), one in sessions or times is credited
 * one, any other unit is credited the gap to its LOW target. The minutes are
 * read off the saved payload's own window — ``ended_at`` minus
 * ``started_at``, to the nearest minute — because that window is what the
 * server derives ``duration_minutes`` from, so the habit is credited exactly
 * the sitting the practice counts.
 *
 * **The posting** is ``creditLinkedHabit``'s: habits re-read from the server
 * first, the ``habitManager`` logUnit pipeline, and quiet on failure.
 */
import { practiceCheckedOffToast } from './practiceHabitCopy';

import type { PracticeSessionCreate } from '@/api';
import type { ToastConfig } from '@/components/Toast';
import { creditLinkedHabit } from '@/features/Habits/creditLinkedHabit';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

const LOG_TAG = 'practiceHabitCheckOff';

export interface PracticeCheckOffRequest {
  /** The linked habit, as stored on ``/ui-flags``. */
  habitId: number;
  /** How long the session ran, to the nearest whole minute. */
  elapsedMinutes: number;
  /** The account zone the day is counted in. */
  tz: string;
  /** Where the one-line confirmation goes. */
  showToast: (_config: ToastConfig) => void;
  /** The clock the check-in is dated by; tests inject it. */
  now?: () => Date;
}

/**
 * The saved session's length to the nearest minute, read off its own window.
 * A window that does not parse is no minutes, never a thrown error: the save
 * has already landed and nothing here may fail it.
 */
export function elapsedMinutesOf(
  window: Pick<PracticeSessionCreate, 'started_at' | 'ended_at'>,
): number {
  const elapsedMs = Date.parse(window.ended_at) - Date.parse(window.started_at);
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.round(elapsedMs / MS_PER_MINUTE);
}

/**
 * Check off the linked habit for one saved practice session. Never throws:
 * every failure ends in a ``console.warn`` and an unchanged store.
 */
export async function checkOffPracticeHabit(request: PracticeCheckOffRequest): Promise<void> {
  await creditLinkedHabit({
    habitId: request.habitId,
    elapsedMinutes: request.elapsedMinutes,
    tz: request.tz,
    showToast: request.showToast,
    now: request.now,
    toast: practiceCheckedOffToast,
    logTag: LOG_TAG,
  });
}
