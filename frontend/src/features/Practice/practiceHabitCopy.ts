/**
 * Microcopy for linking practice sessions to a habit — the practice-side twin
 * of the writing-timer link's strings in ``saveAsHabitCopy.ts`` (#2861).
 *
 * The same tone: a link the person may make or clear, never a target. Nothing
 * here counts sessions, names a cadence, praises the sitting, or implies that
 * leaving the link empty costs anything. ``PRACTICE_HABIT_COPY_ENTRIES``
 * enumerates every user-facing string for the balance-not-altitude sweep.
 */

/** Settings: the group, and the row naming the current link. */
export const PRACTICE_SETTINGS_TITLE = 'Practice';
export const PRACTICE_HABIT_ROW_DESCRIPTION =
  'The habit a finished practice session checks off. Change it or clear it here.';
export const PRACTICE_HABIT_ROW_UNLINKED = 'Practice sessions → not linked';
/** A link the server holds whose habit has not been read yet — never "not linked". */
export const PRACTICE_HABIT_ROW_LINKED_PENDING = 'Practice sessions → a habit';

/**
 * The Settings row's label for a resolved link, or ``null`` for none. A linked
 * habit that is locked is ``paused``: nothing is logged against a locked habit,
 * so the row says so rather than implying a session is still checking it off.
 */
export function practiceHabitRowLabel(
  habitName: string | null,
  { paused = false }: { paused?: boolean } = {},
): string {
  if (habitName === null) return PRACTICE_HABIT_ROW_UNLINKED;
  const label = `Practice sessions → ${habitName}`;
  return paused ? `${label} · paused while locked` : label;
}

/** The "which habit?" step. Only habits the person already keeps are listed. */
export const PRACTICE_HABIT_PICKER_TITLE = 'Which habit?';
/**
 * Strictly true: the picker lists only open habits, and "once it is open" is
 * the condition every check-off actually waits on.
 */
export const PRACTICE_HABIT_PICKER_HELP =
  'Pick a habit you already keep. Once it is open, a finished practice session checks it off.';

/** A habit row's screen-reader label: what choosing it will do. */
export function practiceHabitChooseA11y(habitName: string): string {
  return `Check off ${habitName} when a practice session ends`;
}

export const PRACTICE_HABIT_CLEAR_A11Y = 'Stop checking off a habit when a practice session ends';

/**
 * What a finished practice session says once it has checked off the linked
 * habit. The habit's own name and nothing else: no count, no run of days, no
 * tier reached — the Habits screen is where those live.
 */
export function practiceCheckedOffToast(habitName: string): string {
  return `${habitName} checked off`;
}

/** The name the sweep's samples use; any habit name would do. */
const SAMPLE_HABIT_NAME = 'Sit';

/** Every user-facing string above, gathered for the balance-not-altitude sweep. */
export const PRACTICE_HABIT_COPY_ENTRIES: readonly string[] = [
  PRACTICE_SETTINGS_TITLE,
  PRACTICE_HABIT_ROW_DESCRIPTION,
  PRACTICE_HABIT_ROW_UNLINKED,
  PRACTICE_HABIT_ROW_LINKED_PENDING,
  practiceHabitRowLabel(SAMPLE_HABIT_NAME),
  practiceHabitRowLabel(SAMPLE_HABIT_NAME, { paused: true }),
  PRACTICE_HABIT_PICKER_TITLE,
  PRACTICE_HABIT_PICKER_HELP,
  practiceHabitChooseA11y(SAMPLE_HABIT_NAME),
  PRACTICE_HABIT_CLEAR_A11Y,
  practiceCheckedOffToast(SAMPLE_HABIT_NAME),
];
