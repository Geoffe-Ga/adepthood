/**
 * Accessible names for the trailing close control of each Habits modal.
 *
 * The close control is an icon-only "×", so its name is all a screen reader
 * announces. Each modal carries its own name, after its visible title, because
 * a bare "Close" is already taken inside GoalModal by its backdrop button: two
 * identically named buttons in one sheet are ambiguous to a reader and to a
 * role-and-name locator alike.
 *
 * This module imports nothing, so the browser specs under ``e2e/`` can load
 * the same strings the components render.
 */

/** Fallback name for a ModalHeader whose caller supplies none. */
export const MODAL_CLOSE_LABEL = 'Close';

/** AddHabitModal, titled "Add Habit". */
export const ADD_HABIT_CLOSE_LABEL = 'Close add habit';

/** GoalModal, whose title is the habit's own name. */
export const GOAL_CLOSE_LABEL = 'Close goal sheet';

/** HabitSettingsModal, titled "Edit Habit". */
export const EDIT_HABIT_CLOSE_LABEL = 'Close edit habit';

/** ReorderHabitsModal, titled "Reorder Habits". */
export const REORDER_HABITS_CLOSE_LABEL = 'Close reorder habits';

/** StatsModal, titled "<habit> Stats". */
export const STATS_CLOSE_LABEL = 'Close stats';

/** Every modal-specific name, for the distinctness invariant. */
export const HABIT_MODAL_CLOSE_LABELS: readonly string[] = [
  ADD_HABIT_CLOSE_LABEL,
  GOAL_CLOSE_LABEL,
  EDIT_HABIT_CLOSE_LABEL,
  REORDER_HABITS_CLOSE_LABEL,
  STATS_CLOSE_LABEL,
];
