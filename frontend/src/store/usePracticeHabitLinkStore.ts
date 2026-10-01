/**
 * Which habit a finished practice session checks off: the in-memory mirror of
 * ``practice_session_habit_id`` on ``/ui-flags``.
 *
 * The practice-side twin of ``useWritingHabitLinkStore`` (#2861), built by the
 * same ``createHabitLinkStore`` factory and independent of it: a writer may
 * link the two kinds of session to different habits, or only one of them.
 * ``habitManager``'s delete path must tell this store, as it tells the writing
 * one, when a linked habit is removed on this device.
 */
import { createHabitLinkStore } from './createHabitLinkStore';
import type { HabitLinkState } from './createHabitLinkStore';

export type PracticeHabitLinkState = HabitLinkState;

export const usePracticeHabitLinkStore = createHabitLinkStore(
  'practice_session_habit_id',
  'usePracticeHabitLinkStore',
);
