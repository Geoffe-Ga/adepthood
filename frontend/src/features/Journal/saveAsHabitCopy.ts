/**
 * Microcopy for the offer to keep a timed writing session as a habit.
 *
 * The same tone the writing timer already committed to
 * (``writingTimerCopy.ts``) and the morning-pages tip before it: an offer the
 * writer may take or leave, never a target. So nothing here counts sessions,
 * names a cadence, praises the writing, or implies that declining costs
 * anything — the decline is a plain "No thanks" and it is honoured for good.
 *
 * ``SAVE_AS_HABIT_COPY_ENTRIES`` enumerates every user-facing string for the
 * balance-not-altitude sweep.
 */

/** The habit a kept writing session becomes. */
export const JOURNALING_HABIT_NAME = 'Journaling';

/** Its face, matching the notebook the journal is already drawn as. */
export const JOURNALING_HABIT_ICON = '\u{1F4D3}';

/** The offer itself — one sentence, stating what is on offer and nothing more. */
export const SAVE_AS_HABIT_PROMPT = 'You can keep this as a habit, if you would like it tracked.';

export const SAVE_AS_HABIT_ACCEPT = 'Keep this as a habit';
export const SAVE_AS_HABIT_ACCEPT_A11Y = 'Keep this writing session as a habit';

/** The decline. One tap, and the offer does not come back. */
export const SAVE_AS_HABIT_DECLINE = 'No thanks';
export const SAVE_AS_HABIT_DECLINE_A11Y = 'No thanks, and do not offer this again';

/** The prioritise step: what the writer is choosing, said plainly. */
export const SAVE_AS_HABIT_PLACE_TITLE = 'Where does it sit?';
export const SAVE_AS_HABIT_PLACE_HELP =
  'It goes first unless you move it. Each habit shows the stage it would land on.';

export const SAVE_AS_HABIT_MOVE_EARLIER = 'Move up';
export const SAVE_AS_HABIT_MOVE_EARLIER_A11Y = 'Move Journaling one place up';
export const SAVE_AS_HABIT_MOVE_LATER = 'Move down';
export const SAVE_AS_HABIT_MOVE_LATER_A11Y = 'Move Journaling one place down';

export const SAVE_AS_HABIT_CONFIRM = 'Add it here';
export const SAVE_AS_HABIT_CONFIRM_A11Y = 'Add Journaling in this position';
export const SAVE_AS_HABIT_CANCEL = 'Cancel';
export const SAVE_AS_HABIT_CANCEL_A11Y = 'Cancel placing Journaling, and leave the offer open';

/** Shown while the write is in flight, so a second tap has something to read. */
export const SAVE_AS_HABIT_SAVING = 'Adding…';

/** One row of the preview: the habit, and the stage that position gives it. */
export function stagePreviewLabel(name: string, stage: string): string {
  return `${name} — ${stage}`;
}

/**
 * What happened, once it has happened. It names the lock because every new
 * habit here starts locked, and a writer who went looking for a tile that
 * appeared unlocked would not find one.
 */
export function savedHabitConfirmation(): string {
  return `${JOURNALING_HABIT_NAME} is on your habits list, locked until you open it.`;
}

/**
 * What a finished writing session says once it has checked off the habit the
 * writer linked it to (#2861). The habit's own name and nothing else: no
 * count, no run of days, no tier reached — the Habits screen is where those
 * live, for anyone who goes looking.
 */
export function checkedOffToast(habitName: string): string {
  return `${habitName} checked off`;
}

/**
 * The "which habit?" step (#2861), shared by the offer and by Settings. The
 * writer's own habits are listed by their own names — nothing here guesses
 * which one is "the writing one" — with a new Journaling habit last.
 */
export const WRITING_HABIT_PICKER_TITLE = 'Which habit?';
/**
 * Strictly true for both kinds of choice: the picker lists only open habits,
 * and a new Journaling habit starts locked, so "once it is open" is the
 * condition every check-off actually waits on.
 */
export const WRITING_HABIT_PICKER_HELP =
  'Pick one you already keep, or start a new one. Once it is open, a finished writing timer checks it off.';

/** A habit row's screen-reader label: what choosing it will do. */
export function writingHabitChooseA11y(habitName: string): string {
  return `Check off ${habitName} when a writing timer ends`;
}

export const WRITING_HABIT_NEW = `New habit: ${JOURNALING_HABIT_NAME}`;
export const WRITING_HABIT_NEW_A11Y = `Start a new habit called ${JOURNALING_HABIT_NAME}`;

export const WRITING_HABIT_CLEAR = 'Clear link';
export const WRITING_HABIT_CLEAR_A11Y = 'Stop checking off a habit when a writing timer ends';

export const WRITING_HABIT_CANCEL = 'Cancel';
export const WRITING_HABIT_CANCEL_A11Y = 'Close without choosing a habit';

/** Once linked: what will happen from now on, said once. */
export function linkedHabitConfirmation(habitName: string): string {
  return `${habitName} will be checked off when a timer ends.`;
}

/** Settings: the group, and the row naming the current link. */
export const JOURNAL_SETTINGS_TITLE = 'Journal';
export const WRITING_TIMER_ROW_DESCRIPTION =
  'The habit a finished writing timer checks off. Change it or clear it here.';
export const WRITING_TIMER_ROW_UNLINKED = 'Writing timer → not linked';
/** A link the server holds whose habit has not been read yet — never "not linked". */
export const WRITING_TIMER_ROW_LINKED_PENDING = 'Writing timer → a habit';

/**
 * The Settings row's label for a resolved link, or ``null`` for none. A linked
 * habit that is locked is ``paused``: nothing is logged against a locked habit,
 * so the row says so rather than implying the timer is still checking it off.
 */
export function writingTimerRowLabel(
  habitName: string | null,
  { paused = false }: { paused?: boolean } = {},
): string {
  if (habitName === null) return WRITING_TIMER_ROW_UNLINKED;
  const label = `Writing timer → ${habitName}`;
  return paused ? `${label} · paused while locked` : label;
}

/**
 * Settings: bring the end-of-session offer back. The answer it clears is kept
 * on this device only, so the copy says so rather than promising more.
 */
export const OFFER_AGAIN_LABEL = 'Offer again at the end of a session';
export const OFFER_AGAIN_DESCRIPTION =
  'Shows the keep-this offer after your next finished session, on this device.';
export const OFFER_AGAIN_DONE =
  'The offer will be there after your next finished session on this device.';

/**
 * The new Journaling habit, kept AND linked to the timer. It starts locked like
 * every new habit, and nothing is logged against a locked habit — so the
 * sentence says the check-off begins once it is open, and does not open it on
 * the writer's behalf.
 */
export function savedAndLinkedConfirmation(): string {
  return `${savedHabitConfirmation()} Once it is open, a finished writing timer checks it off.`;
}

/** Every user-facing string above, gathered for the balance-not-altitude sweep. */
export const SAVE_AS_HABIT_COPY_ENTRIES: readonly string[] = [
  JOURNALING_HABIT_NAME,
  SAVE_AS_HABIT_PROMPT,
  SAVE_AS_HABIT_ACCEPT,
  SAVE_AS_HABIT_ACCEPT_A11Y,
  SAVE_AS_HABIT_DECLINE,
  SAVE_AS_HABIT_DECLINE_A11Y,
  SAVE_AS_HABIT_PLACE_TITLE,
  SAVE_AS_HABIT_PLACE_HELP,
  SAVE_AS_HABIT_MOVE_EARLIER,
  SAVE_AS_HABIT_MOVE_EARLIER_A11Y,
  SAVE_AS_HABIT_MOVE_LATER,
  SAVE_AS_HABIT_MOVE_LATER_A11Y,
  SAVE_AS_HABIT_CONFIRM,
  SAVE_AS_HABIT_CONFIRM_A11Y,
  SAVE_AS_HABIT_CANCEL,
  SAVE_AS_HABIT_CANCEL_A11Y,
  SAVE_AS_HABIT_SAVING,
  savedHabitConfirmation(),
  stagePreviewLabel(JOURNALING_HABIT_NAME, 'Beige'),
  checkedOffToast(JOURNALING_HABIT_NAME),
  savedAndLinkedConfirmation(),
  WRITING_HABIT_PICKER_TITLE,
  WRITING_HABIT_PICKER_HELP,
  writingHabitChooseA11y(JOURNALING_HABIT_NAME),
  WRITING_HABIT_NEW,
  WRITING_HABIT_NEW_A11Y,
  WRITING_HABIT_CLEAR,
  WRITING_HABIT_CLEAR_A11Y,
  WRITING_HABIT_CANCEL,
  WRITING_HABIT_CANCEL_A11Y,
  linkedHabitConfirmation(JOURNALING_HABIT_NAME),
  JOURNAL_SETTINGS_TITLE,
  WRITING_TIMER_ROW_DESCRIPTION,
  WRITING_TIMER_ROW_UNLINKED,
  WRITING_TIMER_ROW_LINKED_PENDING,
  writingTimerRowLabel(JOURNALING_HABIT_NAME),
  writingTimerRowLabel(JOURNALING_HABIT_NAME, { paused: true }),
  OFFER_AGAIN_LABEL,
  OFFER_AGAIN_DESCRIPTION,
  OFFER_AGAIN_DONE,
];
