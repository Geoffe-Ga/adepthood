/**
 * Microcopy for the one-tap route from a saved ``Journaling`` practice into a
 * timed writing page.
 *
 * An affordance, never a prod. This is the whole of what the writer is told,
 * and it is deliberately short of anything that would make not tapping it feel
 * like something: no count of pages written, no cadence, no praise for using it
 * and nothing named as lost by leaving it alone. The voice is the one
 * ``morningPagesCopy`` set for the journal — a page is *begun*, and the word
 * "timer" belongs to the control rather than to the invitation.
 *
 * The waiting line is the honest half of it. A practice selected at a stage the
 * writer's calendar has not opened is a real, deliberate state — the server
 * allows the selection and refuses the session (403 ``stage_locked``) — so the
 * page is offered exactly as it always is and the sentence says, before the
 * tap, that what is written there is not counted on the practice yet. It names
 * no restriction on the writing itself, because there is none.
 *
 * ``QUICK_LAUNCH_COPY_ENTRIES`` enumerates every user-facing string for the
 * balance-not-altitude sweep.
 */

/** The affordance itself, in the journal's own invitational voice. */
export const QUICK_LAUNCH_LABEL = 'Begin a timed page';

/** What a screen reader says instead — the whole action, not the visible word. */
export const QUICK_LAUNCH_A11Y = 'Begin a timed writing page for this practice';

/**
 * Said beneath the affordance when the practice sits at a stage still ahead on
 * the writer's calendar. A statement about counting, not about permission.
 */
export const QUICK_LAUNCH_WAITING =
  'This stage is still ahead on your calendar, so a page written here is not counted on the practice yet.';

/** Every user-facing string above, gathered for the balance-not-altitude sweep. */
export const QUICK_LAUNCH_COPY_ENTRIES: readonly string[] = [
  QUICK_LAUNCH_LABEL,
  QUICK_LAUNCH_A11Y,
  QUICK_LAUNCH_WAITING,
];
