/**
 * The rules a manually-logged practice session has to satisfy, mirrored from
 * `backend/src/schemas/practice.py::_session_window_violations`.
 *
 * Kept as a pure module (no React, no API client) for two reasons: the form
 * can refuse an impossible window before spending a request, and the rules
 * stay unit-testable at their boundaries. Every server rule is inclusive
 * (`<=`), so every rule here is too — a strict comparison would refuse a
 * sitting the server would happily record, which is the drift a mid-range
 * test cannot see.
 */
import type { PracticeSessionCreate } from '@/api';
import {
  MAX_BACKDATE_HOURS,
  MAX_BACKDATE_WINDOW_MS,
  MAX_FUTURE_SKEW_MS,
  MAX_SESSION_DURATION_MS,
  MAX_SESSION_HOURS,
} from '@/features/Practice/constants';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

/** One broken rule, named after the server check that owns it. */
export type SessionWindowViolation =
  'ended_before_started' | 'ended_in_future' | 'started_too_old' | 'too_long';

/**
 * Every rule the window breaks, in the order the server checks them.
 *
 * @param startedAt - When the sitting began.
 * @param endedAt - When it ended.
 * @param now - The instant to judge "future" and "too old" against.
 * @returns The violated rules, empty when the server would accept the window.
 */
export function sessionWindowViolations(
  startedAt: Date,
  endedAt: Date,
  now: Date,
): SessionWindowViolation[] {
  const started = startedAt.getTime();
  const ended = endedAt.getTime();
  const instant = now.getTime();
  const rules: [boolean, SessionWindowViolation][] = [
    [ended >= started, 'ended_before_started'],
    [ended <= instant + MAX_FUTURE_SKEW_MS, 'ended_in_future'],
    [instant - started <= MAX_BACKDATE_WINDOW_MS, 'started_too_old'],
    [ended - started <= MAX_SESSION_DURATION_MS, 'too_long'],
  ];
  return rules.filter(([ok]) => !ok).map(([, violation]) => violation);
}

/**
 * What to tell the person for each rule — factual, no shaming, no streak
 * language (NORTH-STAR §3, §10). The numbers come from the same constants the
 * rules compare against, so copy and behaviour cannot disagree.
 */
export const SESSION_WINDOW_COPY: Record<SessionWindowViolation, string> = {
  ended_before_started: 'The session has to end after it starts.',
  ended_in_future: "The end time can't be in the future.",
  started_too_old: `Only sessions from the last ${MAX_BACKDATE_HOURS} hours can be logged in this version.`,
  too_long: `A single session can be at most ${MAX_SESSION_HOURS} hours long.`,
};

/** The standing explanation of the window, shown before anything is wrong. */
export const SESSION_WINDOW_HINT = `You can log a sitting from the last ${MAX_BACKDATE_HOURS} hours, up to ${MAX_SESSION_HOURS} hours long. Older sessions can't be added in this version.`;

export interface ManualSessionPayloadInput {
  userPracticeId: number;
  /** When the sitting ended, as chosen on the form. */
  endedAt: Date;
  /** How long it ran; `started_at` is derived by subtracting it. */
  durationMinutes: number;
}

/**
 * The create payload for a sitting done away from the timer.
 *
 * Carries only the four keys the server needs: it derives `duration_minutes`
 * from the two timestamps (a client-sent duration is refused by
 * `extra="forbid"`), and there is no engine run to harvest `mode_metadata`
 * from, so neither key is sent.
 *
 * @param input - The practice, the end instant, and the minutes practised.
 * @returns The `POST /practice-sessions/` body.
 */
export function manualSessionPayload({
  userPracticeId,
  endedAt,
  durationMinutes,
}: ManualSessionPayloadInput): PracticeSessionCreate {
  const startedAt = new Date(endedAt.getTime() - durationMinutes * MS_PER_MINUTE);
  return {
    user_practice_id: userPracticeId,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    completed: true,
  };
}
