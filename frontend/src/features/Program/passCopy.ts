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

/**
 * Why a start-date picker is not offered while a next pass is pending: a
 * correction would drop that pass, so the line says where its day is changed.
 */
export const pendingPassLockCopy = (day: string): string =>
  `Your next pass begins ${formatPassDay(day)}. To change that day, save Energy Scaffolding again.`;
