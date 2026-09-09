/**
 * Microcopy for the offer to keep a timed writing session as a *practice*.
 *
 * A sibling of ``saveAsHabitCopy`` and held to the same tone: an offer the
 * writer may take or leave, never a target. Nothing here counts sessions,
 * names a cadence, praises the writing, or implies that declining costs
 * anything.
 *
 * What this module carries that the habit one does not is a duty to be
 * ACCURATE about two things the writer cannot see, because both have a cost
 * they would only discover afterwards:
 *
 * 1. **Green may already be held.** One open selection per stage is a database
 *    constraint (``ix_user_practice_active_stage``), and the server resolves a
 *    second one by closing the first. That is a real eviction of something the
 *    writer chose, so the practice it would displace is named before the tap,
 *    not reported after it.
 * 2. **Green may not be open yet.** Journaling can still be selected there —
 *    the server allows a forward-planned selection on purpose — but the
 *    just-finished session cannot be logged against a stage the writer has not
 *    reached. So the sentence says the session is not counted rather than
 *    implying it was.
 *
 * ``SAVE_AS_PRACTICE_COPY_ENTRIES`` enumerates every user-facing string for the
 * balance-not-altitude sweep, including one rendering of each composed
 * sentence.
 */

/** The practice a kept writing session becomes — the seeded catalogue row's name. */
export const JOURNALING_PRACTICE_NAME = 'Journaling';

/** The stage the practice sits at, named as the writer sees it. */
export const GREEN_STAGE_LABEL = 'Green';

/** The invitation's second action, beside the habit one. */
export const SAVE_AS_PRACTICE_ACCEPT = 'Keep this as a practice';
export const SAVE_AS_PRACTICE_ACCEPT_A11Y = 'Keep this writing session as a practice';

/** Shown while the three lookups behind the summary are in flight. */
export const SAVE_AS_PRACTICE_CHECKING = 'Looking at your practices…';

/** The confirm, in its two shapes: a plain keep, and one that displaces something. */
export const SAVE_AS_PRACTICE_CONFIRM = 'Keep it';
export const SAVE_AS_PRACTICE_CONFIRM_A11Y = 'Keep Journaling as a practice at Green';
export const SAVE_AS_PRACTICE_REPLACE = 'Put Journaling there';
export const SAVE_AS_PRACTICE_REPLACE_A11Y = 'Replace the practice held at Green with Journaling';

/** Shown while the write is in flight, so a second tap has something to read. */
export const SAVE_AS_PRACTICE_SAVING = 'Keeping…';

/** The plain way out when nothing would be displaced. */
export const SAVE_AS_PRACTICE_DECLINE = 'Not now';
export const SAVE_AS_PRACTICE_CANCEL_A11Y =
  'Leave your practices as they are, and leave the offer open';

/**
 * Neither lookup nor write landed. Both say what is true of the writer's
 * practices, because "it did not work" without that is the sentence that sends
 * someone to the practice screen to check.
 */
export const SAVE_AS_PRACTICE_UNAVAILABLE =
  'Your practices could not be read just now. Nothing has changed.';
export const SAVE_AS_PRACTICE_FAILED = 'That did not save. Nothing has changed.';

/** What the summary is composed from: the two facts the writer cannot see. */
export interface KeepPracticeSituation {
  /** The open selection Journaling would displace at Green, or ``null``. */
  readonly displaces: string | null;
  /** The stage the writer is at when Green is not open to them yet, or ``null``. */
  readonly waitingAt: string | null;
}

/**
 * What keeping this as a practice would actually do, in one to three sentences.
 *
 * Composed rather than switched over, so the case where BOTH are true — Green
 * is held AND not yet open — says both instead of picking one and dropping the
 * other on the floor.
 *
 * @param situation - What is at Green, and whether the writer has reached it.
 * @returns The sentences to show above the confirm.
 */
export function keepPracticeSummary({ displaces, waitingAt }: KeepPracticeSituation): string {
  const lines = [`${JOURNALING_PRACTICE_NAME} sits at ${GREEN_STAGE_LABEL}.`];
  if (displaces !== null) {
    lines.push(
      `${GREEN_STAGE_LABEL} is holding ${displaces} — keeping ${JOURNALING_PRACTICE_NAME} puts it there instead.`,
    );
  }
  lines.push(
    waitingAt === null
      ? 'This session is counted on it.'
      : `You are at ${waitingAt}, so it waits at ${GREEN_STAGE_LABEL} and this session is not counted on it.`,
  );
  return lines.join(' ');
}

/**
 * The way out of the confirm, named after what taking it preserves.
 *
 * "Not now" is enough when nothing is at stake. When a selection would be
 * displaced, the way out names it: the choice is between two practices, and a
 * generic "Cancel" makes the writer work out which one it keeps.
 *
 * @param displaces - The practice Green is holding, or ``null``.
 * @returns The label for the non-committing action.
 */
export function keepPracticeCancelLabel(displaces: string | null): string {
  return displaces === null ? SAVE_AS_PRACTICE_DECLINE : `Keep ${displaces}`;
}

/**
 * What happened, once it has happened.
 *
 * The session clause is conditional because a forward-planned selection logs
 * nothing, and a sentence claiming a session that was never written would be
 * the one thing the writer could not check.
 *
 * @param sessionLogged - Whether the finished session was recorded.
 * @returns The confirmation sentence.
 */
export function keptPracticeConfirmation(sessionLogged: boolean): string {
  const kept = `${JOURNALING_PRACTICE_NAME} is one of your practices at ${GREEN_STAGE_LABEL}.`;
  return sessionLogged ? `${kept} This session is on it.` : kept;
}

/** A stand-in name used only to render a composed entry for the sweep below. */
const SWEEP_EXAMPLE_PRACTICE = 'Loving-kindness';

/** Every user-facing string above, gathered for the balance-not-altitude sweep. */
export const SAVE_AS_PRACTICE_COPY_ENTRIES: readonly string[] = [
  JOURNALING_PRACTICE_NAME,
  SAVE_AS_PRACTICE_ACCEPT,
  SAVE_AS_PRACTICE_ACCEPT_A11Y,
  SAVE_AS_PRACTICE_CHECKING,
  SAVE_AS_PRACTICE_CONFIRM,
  SAVE_AS_PRACTICE_CONFIRM_A11Y,
  SAVE_AS_PRACTICE_REPLACE,
  SAVE_AS_PRACTICE_REPLACE_A11Y,
  SAVE_AS_PRACTICE_SAVING,
  SAVE_AS_PRACTICE_DECLINE,
  SAVE_AS_PRACTICE_CANCEL_A11Y,
  SAVE_AS_PRACTICE_UNAVAILABLE,
  SAVE_AS_PRACTICE_FAILED,
  keepPracticeSummary({ displaces: null, waitingAt: null }),
  keepPracticeSummary({ displaces: SWEEP_EXAMPLE_PRACTICE, waitingAt: 'Beige' }),
  keepPracticeCancelLabel(SWEEP_EXAMPLE_PRACTICE),
  keptPracticeConfirmation(true),
  keptPracticeConfirmation(false),
];
