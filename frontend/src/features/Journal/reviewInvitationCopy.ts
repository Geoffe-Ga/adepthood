/**
 * Microcopy for the shelf's review invitation and the early-review picker
 * (issue #2867) — the offer to look back on a week, a stage, a section or the
 * whole course, on the day it comes round or any day before.
 *
 * "You choose your depth": every line is a declinable offer. There is no
 * streak, no count, and no pressure to keep up, so nothing here ranks, shames,
 * or pushes. ``REVIEW_INVITATION_COPY_ENTRIES`` enumerates every user-facing
 * string for the balance-not-altitude sweep.
 */
import type { ReflectionLevel } from '@/api';

/** The caption above a review that has come due — an offer, not a deadline. */
export const REVIEW_BAND_LABEL = 'A reflection has come round';

/** The line beneath a fresh review's title. */
export const REVIEW_INVITE_SUBLINE = 'A quiet space to look back — only if you like.';

/** The line beneath a review already begun, so the tap reads as a return. */
export const REVIEW_RESUME_SUBLINE = 'Pick up where you left off.';

/** The decline affordance on a due review. */
export const REVIEW_DISMISS = 'Not now';

/**
 * The accessibility label for declining a due review. Every accessible name in
 * this module OPENS with the words the control shows (WCAG 2.5.3, label in
 * name), so a voice-control user can say what they see.
 */
export const REVIEW_DISMISS_A11Y = 'Not now, set this reflection invitation aside';

/** The quiet link that opens the early-review picker, present every day. */
export const REVIEW_EARLY_LINK = 'Start a review early';

/** The accessibility label for opening the early-review picker. */
export const REVIEW_EARLY_A11Y = 'Start a review early, choose one to begin before it comes round';

/** The same link once the picker is open, offering to fold it away again. */
export const REVIEW_EARLY_CLOSE = 'Fold the reviews away';

/** The accessibility label for folding the picker away. */
export const REVIEW_EARLY_CLOSE_A11Y =
  'Fold the reviews away, close the list of reviews you could begin early';

/** Shown in the picker when nothing is open yet — before the program begins. */
export const PICKER_EMPTY = 'No review is open yet. They open once your program begins.';

/** Shown in the picker when the open reviews could not be reached. */
export const PICKER_UNAVAILABLE =
  'The reviews could not be reached just now. Your daily page is still here.';

/** The noun each layer's review goes by, in the program's own words. */
const REVIEW_NOUN: Readonly<Record<ReflectionLevel, string>> = {
  week: 'Weekly Review',
  stage: 'Stage Review',
  section: 'Section Review',
  course: 'Course Review',
};

/** The primary CTA on a review day, e.g. "Write your Weekly Review". */
export function writeReviewCta(level: ReflectionLevel): string {
  return `Write your ${REVIEW_NOUN[level]}`;
}

/** The visible label of a picker row whose review is already begun. */
export function continueReviewLabel(title: string): string {
  return `Continue — ${title}`;
}

/** The accessibility label for a picker row that starts a fresh review; it shows ``title``. */
export function beginReviewA11y(title: string): string {
  return `${title}, begin this review`;
}

/** The accessibility label for a picker row returning to a review already begun. */
export function continueReviewA11y(title: string): string {
  return `${continueReviewLabel(title)}, reopen the review you began`;
}

/**
 * The due card's accessibility label: its visible CTA first ("Write your
 * Weekly Review"), then which scope it begins or continues.
 */
export function reviewCtaA11y(level: ReflectionLevel, title: string, resuming: boolean): string {
  return `${writeReviewCta(level)}, ${resuming ? 'continue' : 'begin'} your ${title}`;
}

/** Every user-facing review-invitation string, gathered for the balance-not-altitude sweep. */
export const REVIEW_INVITATION_COPY_ENTRIES: readonly string[] = [
  REVIEW_BAND_LABEL,
  REVIEW_INVITE_SUBLINE,
  REVIEW_RESUME_SUBLINE,
  REVIEW_DISMISS,
  REVIEW_DISMISS_A11Y,
  REVIEW_EARLY_LINK,
  REVIEW_EARLY_A11Y,
  REVIEW_EARLY_CLOSE,
  REVIEW_EARLY_CLOSE_A11Y,
  PICKER_EMPTY,
  PICKER_UNAVAILABLE,
  ...Object.values(REVIEW_NOUN).map((noun) => `Write your ${noun}`),
];
