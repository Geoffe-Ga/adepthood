/**
 * Which habit a finished writing session checks off (#2861): the in-memory
 * mirror of ``writing_session_habit_id`` on ``/ui-flags``.
 *
 * One instance of ``createHabitLinkStore``, which holds the rules (a failed
 * read is not an answer; the server's echo is the truth; an answer belongs to
 * the account that asked). Its public shape is unchanged from before the
 * factory existed, so every caller and test reads as it did.
 */
import { createHabitLinkStore } from './createHabitLinkStore';
import type { HabitLinkState } from './createHabitLinkStore';

export type WritingHabitLinkState = HabitLinkState;

export const useWritingHabitLinkStore = createHabitLinkStore(
  'writing_session_habit_id',
  'useWritingHabitLinkStore',
);
