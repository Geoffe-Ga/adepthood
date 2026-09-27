/**
 * The words of the promote-a-quote explainer and of the notice that confirms a
 * promotion (#2864).
 *
 * "Promote a quote" used to open a selection field with no word about what
 * promotion is, and the confirmation said only "Promoted" — the reader was
 * never told where the passage went. So the explainer says two things, in this
 * order: what promotion does, and where the reader can see it any time
 * (Promoted quotes, a door in the Journal menu, named exactly as that door is
 * labelled). The notice then names that same door, so it confirms the promise
 * rather than restating a verb.
 *
 * Both are held to what the code does. ``GET /reflections/sources`` attaches a
 * pending quote to the entry it came from, so it surfaces among the sources of
 * a review whose window covers the day that entry was written (a weekly review
 * of that week, or a longer review taking in that week when no weekly review
 * stands in for it) — not in whichever review happens to come next. Promoting
 * a passage from an old entry does not put it in this week's review, so the
 * copy says "a review that covers the week you wrote it". The notice names the
 * Promoted quotes screen because that is the one place that always lists it.
 *
 * Nothing here argues for promoting. Promotion is one of the self-chosen depths
 * (NORTH-STAR: "you choose your depth"): the note is flat about what happens,
 * the decline is the same size as the go-ahead, and ticking the box is how a
 * reader who already knows makes the note step aside.
 */

/** The heading: the affordance's own name, so the reader knows what they pressed. */
export const PROMOTE_EXPLAINER_TITLE = 'Promote a quote';

/** What promotion does, and where a promoted passage can be found again. */
export const PROMOTE_EXPLAINER_BODY =
  'A promoted passage waits among the sources of a review that covers the week you wrote it, ready to fold into what you write there. You can see every promoted quote any time under Promoted quotes in the Journal menu.';

export const PROMOTE_EXPLAINER_CONTINUE = 'Choose the passage';
export const PROMOTE_EXPLAINER_CONTINUE_A11Y = 'Choose the passage to promote';

export const PROMOTE_EXPLAINER_CANCEL = 'Not now';
export const PROMOTE_EXPLAINER_CANCEL_A11Y = 'Not now — keep reading';

export const PROMOTE_EXPLAINER_DONT_SHOW = 'Don’t show this again';
export const PROMOTE_EXPLAINER_DONT_SHOW_A11Y =
  'Don’t show this note again before promoting a quote';

export const PROMOTE_EXPLAINER_SCRIM_A11Y = 'Dismiss the promote note';

/** The transient confirmation after a promote lands, naming where it went. */
export const PROMOTED_NOTICE_COPY = 'Promoted — find it any time under Promoted quotes';

/** Every reader-facing line above, for the balance-not-altitude sweep. */
export const PROMOTE_EXPLAINER_COPY_ENTRIES: readonly string[] = [
  PROMOTE_EXPLAINER_TITLE,
  PROMOTE_EXPLAINER_BODY,
  PROMOTE_EXPLAINER_CONTINUE,
  PROMOTE_EXPLAINER_CONTINUE_A11Y,
  PROMOTE_EXPLAINER_CANCEL,
  PROMOTE_EXPLAINER_CANCEL_A11Y,
  PROMOTE_EXPLAINER_DONT_SHOW,
  PROMOTE_EXPLAINER_DONT_SHOW_A11Y,
  PROMOTE_EXPLAINER_SCRIM_A11Y,
  PROMOTED_NOTICE_COPY,
];
