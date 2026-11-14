/**
 * The words of the promote-a-quote explainer and of the notice that confirms a
 * promotion (#2864).
 *
 * "Promote a quote" used to open a selection field with no word about what
 * promotion is, and the confirmation said only "Promoted" — the reader was
 * never told where the passage went. So the explainer says two things, in this
 * order: what promotion does, and where the reader can see it any time
 * (Write a review, a door in the Journal menu, named exactly as that door is
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
 * Write a review door because the Promoted quotes screen it opens is the one
 * place that always lists it.
 *
 * A chapter or a letter has no week of its own (#3660). ``GET /reflections/sources``
 * offers a reading quote to the review whose window covers the day it was
 * promoted, so the reading variant says "the review covering the week you
 * promote it" (owner decision); the entry wording is untouched. A Course
 * chapter shows the note at the Promote press, with the passage already
 * chosen, so its go-ahead promotes rather than asking for a passage.
 *
 * Nothing here argues for promoting. Promotion is one of the self-chosen depths
 * (NORTH-STAR: "you choose your depth"): the note is flat about what happens,
 * the decline is the same size as the go-ahead, and ticking the box is how a
 * reader who already knows makes the note step aside.
 */

import type { PromotedQuoteSourceKind } from '@/api';

/** The heading: the affordance's own name, so the reader knows what they pressed. */
export const PROMOTE_EXPLAINER_TITLE = 'Promote a quote';

/** What promotion does, and where a promoted passage can be found again. */
export const PROMOTE_EXPLAINER_BODY =
  'A promoted passage waits among the sources of a review that covers the week you wrote it, ready to fold into what you write there. You can see every promoted quote any time under Write a review in the Journal menu.';

/** What promoting a passage of a Course chapter or a letter does, and where it waits. */
export const PROMOTE_EXPLAINER_READING_BODY =
  'A promoted passage waits among the sources of the review covering the week you promote it, ready to fold into what you write there. You can see every promoted quote any time under Promoted quotes in the Journal menu.';

export const PROMOTE_EXPLAINER_CONTINUE = 'Choose the passage';
export const PROMOTE_EXPLAINER_CONTINUE_A11Y = 'Choose the passage to promote';

/** The go-ahead once the passage is already chosen (a Course chapter's Promote). */
export const PROMOTE_EXPLAINER_PROMOTE = 'Promote the passage';
export const PROMOTE_EXPLAINER_PROMOTE_A11Y = 'Promote the passage you chose';

export const PROMOTE_EXPLAINER_CANCEL = 'Not now';
export const PROMOTE_EXPLAINER_CANCEL_A11Y = 'Not now — keep reading';

export const PROMOTE_EXPLAINER_DONT_SHOW = 'Don’t show this again';
export const PROMOTE_EXPLAINER_DONT_SHOW_A11Y =
  'Don’t show this note again before promoting a quote';

export const PROMOTE_EXPLAINER_SCRIM_A11Y = 'Dismiss the promote note';

/** The transient confirmation after a promote lands, naming where it went. */
export const PROMOTED_NOTICE_COPY = 'Promoted — find it any time under Write a review';

/** The words that change with where, and when, the note is shown. */
export interface PromoteExplainerWords {
  body: string;
  continueLabel: string;
  continueA11y: string;
}

/**
 * The explainer's words for a promote from ``kind`` of source: shown before a
 * passage is chosen (the journal, a letter), or once one is (a chapter's pill).
 */
export function promoteExplainerWords(
  kind: PromotedQuoteSourceKind,
  passageChosen = false,
): PromoteExplainerWords {
  return {
    body: kind === 'entry' ? PROMOTE_EXPLAINER_BODY : PROMOTE_EXPLAINER_READING_BODY,
    continueLabel: passageChosen ? PROMOTE_EXPLAINER_PROMOTE : PROMOTE_EXPLAINER_CONTINUE,
    continueA11y: passageChosen ? PROMOTE_EXPLAINER_PROMOTE_A11Y : PROMOTE_EXPLAINER_CONTINUE_A11Y,
  };
}

/** Every reader-facing line above, for the balance-not-altitude sweep. */
export const PROMOTE_EXPLAINER_COPY_ENTRIES: readonly string[] = [
  PROMOTE_EXPLAINER_TITLE,
  PROMOTE_EXPLAINER_BODY,
  PROMOTE_EXPLAINER_READING_BODY,
  PROMOTE_EXPLAINER_CONTINUE,
  PROMOTE_EXPLAINER_CONTINUE_A11Y,
  PROMOTE_EXPLAINER_PROMOTE,
  PROMOTE_EXPLAINER_PROMOTE_A11Y,
  PROMOTE_EXPLAINER_CANCEL,
  PROMOTE_EXPLAINER_CANCEL_A11Y,
  PROMOTE_EXPLAINER_DONT_SHOW,
  PROMOTE_EXPLAINER_DONT_SHOW_A11Y,
  PROMOTE_EXPLAINER_SCRIM_A11Y,
  PROMOTED_NOTICE_COPY,
];
