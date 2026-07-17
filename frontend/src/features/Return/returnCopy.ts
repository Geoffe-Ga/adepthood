/**
 * Microcopy for the Return — the declinable five-week Metta arc offered as a
 * soft landing (NORTH-STAR "you choose your depth").
 *
 * Every line reads like a wise friend offering rest, never a verdict. Contraction
 * follows expansion; a Return is a skillful pause, not a failure — so nothing
 * here ranks, shames, or pressures. ``RETURN_COPY_ENTRIES`` enumerates every
 * user-facing string for the balance-not-altitude sweep.
 */

/** The offer card heading — an invitation, softly phrased. */
export const RETURN_OFFER_HEADING = 'A gentle Return, if you would like one';

/** The offer card body — what the arc is, framed as a return to steady ground. */
export const RETURN_OFFER_BODY =
  'Contraction follows expansion. If it feels right, there is a five-week Metta arc here — a return to steadier, more secure ground you can begin, pause, or set down whenever you choose. It only adds to what you have already grown.';

/** The accept affordance label. */
export const RETURN_OFFER_ACCEPT = 'Begin the Return';

/** The accessibility label for accepting the offer. */
export const RETURN_OFFER_ACCEPT_A11Y = 'Begin the five-week Return';

/** The decline affordance label. */
export const RETURN_OFFER_DISMISS = 'Not now';

/** The accessibility label for declining the offer. */
export const RETURN_OFFER_DISMISS_A11Y = 'Set the Return offer aside for now';

/** The pause affordance label on the active arc. */
export const RETURN_ARC_PAUSE = 'Pause';

/** The accessibility label for pausing the arc. */
export const RETURN_ARC_PAUSE_A11Y = 'Pause the Return, resting where you are';

/** The resume affordance label on a paused arc. */
export const RETURN_ARC_RESUME = 'Resume';

/** The accessibility label for resuming the arc. */
export const RETURN_ARC_RESUME_A11Y = 'Resume the Return where you left off';

/** The leave affordance label on the active arc. */
export const RETURN_ARC_LEAVE = 'Set it down';

/** The accessibility label for leaving the arc. */
export const RETURN_ARC_LEAVE_A11Y = 'Set the Return down; nothing about your progress changes';

/** The completion-card heading — a quiet, reflective close, not a reward. */
export const RETURN_COMPLETE_HEADING = 'The circle has come full round';

/** The completion-card body — all five foci met, self through all beings; a soft close. */
export const RETURN_COMPLETE_BODY =
  'Five weeks of loving-kindness, from yourself outward to all beings — every focus met, gently and in your own time. There is nothing more to reach for here; you might simply rest in the warmth you have grown, and set the arc down whenever it feels finished.';

/** The let-go picker heading — an invitation to rest what needs resting. */
export const RETURN_LETGO_HEADING = 'Set anything down that needs rest';

/** The let-go picker body — releasing framed as tending the foundation, not failing. */
export const RETURN_LETGO_BODY =
  'Returning is a good moment to tend the foundation. Choose any habits to let rest for now — they simply pause, waiting for you, and nothing you have already grown is undone.';

/** The release affordance label on the let-go picker. */
export const RETURN_LETGO_RELEASE = 'Let these rest';

/** The accessibility label for releasing the chosen habits. */
export const RETURN_LETGO_RELEASE_A11Y = 'Let the chosen habits rest for now';

/** The skip affordance label on the let-go picker. */
export const RETURN_LETGO_SKIP = 'Keep them all';

/** The accessibility label for skipping the let-go picker. */
export const RETURN_LETGO_SKIP_A11Y = 'Leave every habit as it is for now';

/** The let-go empty state — shown when no revealed habits are available to rest. */
export const RETURN_LETGO_EMPTY = 'There are no active habits to set down right now.';

/** The let-go load-error line — a flaky fetch, distinct from having nothing to rest. */
export const RETURN_LETGO_ERROR =
  'These could not load just now — keep everything as it is, or check back in a moment.';

/** Build the per-habit selection label for the let-go picker, naming the habit warmly. */
export function buildReturnLetGoHabitA11y(name: string): string {
  return `Let ${name} rest for now`;
}

/** The re-commit section heading — the habits resting from this Return. */
export const RETURN_RECOMMIT_HEADING = 'Habits resting from this Return';

/** The re-commit section body — take one up again, or let it keep resting; both are whole. */
export const RETURN_RECOMMIT_BODY =
  'These rested while you circled back to steadier ground. Take up any that feel ready again, or let them keep resting — both are whole.';

/** The per-habit re-commit affordance label. */
export const RETURN_RECOMMIT_ACTION = 'Take it up again';

/** Build the per-habit re-commit label, naming the habit and offering to take it up again. */
export function buildReturnRecommitA11y(name: string): string {
  return `Take it up again: ${name}`;
}

/** Every user-facing Return string, gathered for the balance-not-altitude sweep. */
export const RETURN_COPY_ENTRIES: readonly string[] = [
  RETURN_OFFER_HEADING,
  RETURN_OFFER_BODY,
  RETURN_OFFER_ACCEPT,
  RETURN_OFFER_ACCEPT_A11Y,
  RETURN_OFFER_DISMISS,
  RETURN_OFFER_DISMISS_A11Y,
  RETURN_ARC_PAUSE,
  RETURN_ARC_PAUSE_A11Y,
  RETURN_ARC_RESUME,
  RETURN_ARC_RESUME_A11Y,
  RETURN_ARC_LEAVE,
  RETURN_ARC_LEAVE_A11Y,
  RETURN_COMPLETE_HEADING,
  RETURN_COMPLETE_BODY,
  RETURN_LETGO_HEADING,
  RETURN_LETGO_BODY,
  RETURN_LETGO_RELEASE,
  RETURN_LETGO_RELEASE_A11Y,
  RETURN_LETGO_SKIP,
  RETURN_LETGO_SKIP_A11Y,
  RETURN_LETGO_EMPTY,
  RETURN_LETGO_ERROR,
  RETURN_RECOMMIT_HEADING,
  RETURN_RECOMMIT_BODY,
  RETURN_RECOMMIT_ACTION,
];
