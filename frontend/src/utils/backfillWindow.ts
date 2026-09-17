/**
 * The client mirror of "how far back may a completion be logged?".
 *
 * The rule has exactly one owner: `day_window_verdict` in
 * `backend/src/domain/dates.py:199-212`, with the width in
 * `MAX_BACKFILL_DAYS` there. This module restates neither the rule nor the
 * number for its own sake — it exists because the journal offer card has to
 * say, before the writer consents, what pressing OK will actually log, and the
 * accept re-checks the suggested day against this same window:
 * `_in_window_day` (`backend/src/routers/journal.py:2115-2128`) returns `None`
 * for a `future` or `too_old` day and the accept then silently logs **today**.
 * A card that named the refused day would promise something the server does
 * not do.
 *
 * `frontend/src/utils/__tests__/backfillWindowDrift.test.ts` derives
 * `MAX_BACKFILL_DAYS` from the Python, so widening or narrowing the server's
 * window fails here rather than in a user's margin.
 *
 * Pure day math, exactly as the Python is: today is a parameter, never a clock
 * read, so a caller that has already resolved the user's local day passes it
 * in rather than this module guessing a zone.
 */
import { DEFAULT_TIMEZONE, addDaysInTZ } from './dateUtils';

/**
 * Days before today a completion may still be backdated to, inclusive.
 *
 * Mirrors `MAX_BACKFILL_DAYS` in `backend/src/domain/dates.py`.
 */
export const MAX_BACKFILL_DAYS = 30;

/** Why a day may not be logged against, or `'ok'` when it may. */
export type DayWindow = 'ok' | 'future' | 'too_old';

/**
 * Classify `dayKey` against the backfill window ending at `todayKey`.
 *
 * Both arguments are `YYYY-MM-DD` keys already in the user's own calendar, so
 * the comparison is lexicographic and needs no zone: the keys sort exactly as
 * the dates do. `addDaysInTZ` supplies the window's far edge; its `tz`
 * parameter is documented as unused pure calendar math
 * (`dateUtils.ts` — "a calendar day is a calendar day everywhere"), so
 * `DEFAULT_TIMEZONE` is passed for API stability rather than as a claim about
 * the user's zone.
 *
 * Both endpoints inclusive, matching the Python.
 *
 * @param dayKey - The day being proposed, `YYYY-MM-DD`.
 * @param todayKey - The user's today, `YYYY-MM-DD`.
 * @returns `'future'`, `'too_old'`, or `'ok'`.
 */
export const dayWindowVerdict = (dayKey: string, todayKey: string): DayWindow => {
  if (dayKey > todayKey) return 'future';
  if (dayKey < addDaysInTZ(todayKey, -MAX_BACKFILL_DAYS, DEFAULT_TIMEZONE)) return 'too_old';
  return 'ok';
};
