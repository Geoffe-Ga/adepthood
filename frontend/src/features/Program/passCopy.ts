/**
 * The words for a pass that has not begun yet (#3728).
 *
 * Informational and declinable in the product's sense (``NORTH-STAR.md``): a
 * day and, where it helps, how far off it is -- no badge, no urgency, no call
 * to action. Every string names the day in full, read from the ``YYYY-MM-DD``
 * the server sent, so no device zone can move it to the day before.
 */
import { parseISODate } from '../../components/DatePicker';

/** The one day that is spoken as a word rather than a count. */
const ONE_DAY = 1;

/** ``2026-12-01`` -> "December 1, 2026". */
export const formatPassDay = (day: string): string =>
  parseISODate(day).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

/**
 * The review step's one sentence before a save that opens a pass: what the
 * save starts, and that the pass being left behind is kept.
 */
export const newPassSentence = (day: string): string =>
  `Saving starts a new pass on ${formatPassDay(day)}; your current pass stays on Stats and progress.`;

/** The Habits notice while a pass is held for the future and the current one keeps running. */
export const nextPassNotice = (day: string): string =>
  `Your next pass begins ${formatPassDay(day)}.`;

/**
 * ``2026-12-01`` -> "December 1": for a line that also says how many days off
 * the day is, which already places it within the year ahead.
 */
const formatNearDay = (day: string): string =>
  parseISODate(day).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

/** "tomorrow", or "in N days". */
const countdown = (daysUntil: number): string =>
  daysUntil === ONE_DAY ? 'tomorrow' : `in ${daysUntil} days`;

/** The Habits notice while a first pass placed in the future has not begun. */
export const programBeginsNotice = (day: string, daysUntil: number): string =>
  `Your program begins ${formatNearDay(day)}, ${countdown(daysUntil)}.`;

/** The sentence that keeps the pass the person is leaving on the record. */
const KEPT_PASS = 'your current pass stays on Stats and progress.';

/**
 * What saving a pending pass's day will do, said before the save (#3747): the
 * held day unchanged sends nothing; a later day moves the pass; today or an
 * earlier day starts it now, because ``POST /stages/passes`` opens a pass on
 * any day that has come.
 */
export const pendingPassSentence = (day: string, held: string, today: string): string => {
  if (day === held) return nextPassNotice(day);
  if (day > today) return `Saving moves your next pass to ${formatPassDay(day)}.`;
  if (day === today) return `Saving starts your next pass today; ${KEPT_PASS}`;
  return `Saving starts your next pass now, counted from ${formatPassDay(day)}; ${KEPT_PASS}`;
};

/** The confirmation once a pending pass's new day has saved (#3747). */
export const pendingPassSavedCopy = (day: string, today: string): string =>
  day > today
    ? `Saved. Your next pass now begins ${formatPassDay(day)}.`
    : `Saved. Your new pass has begun, counted from ${formatPassDay(day)}.`;

/**
 * A pending pass's new day that never reached the server (offline, timeout,
 * 5xx): what did not happen, what to do, and the day that still stands.
 */
export const pendingPassNotSavedCopy = (held: string): string =>
  `Your next pass's day didn't save. Check your connection and save again; it still begins ${formatPassDay(held)}.`;
