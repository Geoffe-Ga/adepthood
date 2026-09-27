/**
 * Every line the multi-select fold-in shows (#2885), in one place so the copy
 * sweep can read all of it.
 *
 * The vocabulary is the one the sources panel already speaks -- a quote is
 * "folded into" a review -- and a quote only ever folds into a REVIEW: the
 * server marks a quote included only in a hierarchical reflection (#1458), and
 * the Promoted quotes screen's "Not yet in a review" / "Used in a review"
 * headings (#2971) stay true because of it. Nothing here counts down, ranks,
 * or asks for more than the writer chose.
 */

/** Singular below this many quotes; the plural from here on. */
const SINGLE_QUOTE = 1;

/** "1 quote" / "3 quotes". */
function quoteCount(n: number): string {
  return n === SINGLE_QUOTE ? `${SINGLE_QUOTE} quote` : `${n} quotes`;
}

/** Enters selection mode. */
export const SELECT_QUOTES_LABEL = 'Select quotes';
/** Leaves selection mode, dropping the selection. */
export const CANCEL_SELECTING_LABEL = 'Cancel selection';
/** Checks every quote still waiting. */
export const SELECT_ALL_LABEL = 'Select all';
/** Unchecks every quote. */
export const CLEAR_ALL_LABEL = 'Clear all';
/** The fold action with nothing checked: says what to do, and is disabled. */
export const FOLD_NONE_LABEL = 'Choose quotes to fold in';

/** The fold action: "Fold 1 quote into this review" / "Fold 3 quotes into this review". */
export function foldSelectedLabel(n: number): string {
  return n === 0 ? FOLD_NONE_LABEL : `Fold ${quoteCount(n)} into this review`;
}

/** The screen's action with no review to fold into: open the picker carrying the quotes. */
export function writeReviewWithLabel(n: number): string {
  return n === 0 ? FOLD_NONE_LABEL : `Write a review with ${quoteCount(n)}`;
}

/**
 * Said beside "Select all" while older quotes are still unloaded. Select all
 * checks the rows on screen, not the section's whole total, and the heading's
 * count would otherwise let the reader believe it had taken every one.
 */
export const SELECT_ALL_LOADED_NOTE =
  'Select all checks the quotes shown here. Older quotes join in once you load them.';

/** A folded quote's name gains this, so its state is heard as well as seen. */
export const FOLDED_SUFFIX = ' — already in your review';

/** A pending quote's accessible name outside selection mode: the tap folds it in. */
export function foldQuoteA11y(text: string): string {
  return `Fold the quote "${text}" into your reflection`;
}

/** A pending quote's accessible name as a checkbox: the words; checked carries the rest. */
export function selectQuoteA11y(text: string): string {
  return `The quote "${text}"`;
}

/**
 * The composer's warm line when some folded quotes did not get marked as used.
 * Names what happened and that the words are safe; the retry beside it is an
 * offer, not a task. It counts the waiting quotes rather than naming them, by
 * decision (#2754): see ``QuoteInclusionHint`` for why.
 */
export function inclusionRetryHint(n: number): string {
  const subject = n === SINGLE_QUOTE ? 'One quote is' : `${quoteCount(n)} are`;
  const marked = n === SINGLE_QUOTE ? 'isn’t' : 'aren’t';
  return `${subject} in your review but ${marked} marked as used yet — try again whenever you like.`;
}

/** The retry beside that line. */
export const RETRY_INCLUSION_LABEL = 'Try again';

/** Every fixed line above plus a sample of each templated one, for the copy sweep. */
export const QUOTE_FOLD_COPY_ENTRIES: readonly string[] = [
  SELECT_QUOTES_LABEL,
  CANCEL_SELECTING_LABEL,
  SELECT_ALL_LABEL,
  CLEAR_ALL_LABEL,
  FOLD_NONE_LABEL,
  foldSelectedLabel(1),
  foldSelectedLabel(3),
  writeReviewWithLabel(1),
  writeReviewWithLabel(3),
  SELECT_ALL_LOADED_NOTE,
  FOLDED_SUFFIX,
  inclusionRetryHint(1),
  inclusionRetryHint(3),
  RETRY_INCLUSION_LABEL,
];
