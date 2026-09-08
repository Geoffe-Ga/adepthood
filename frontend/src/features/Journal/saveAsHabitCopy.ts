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
];
