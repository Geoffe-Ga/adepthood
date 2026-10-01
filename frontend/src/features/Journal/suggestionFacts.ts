/**
 * What pressing OK on a completion offer will actually log -- or, once it is
 * settled, what it did log -- as a sentence fragment.
 *
 * The offer card used to show only the writer's own quoted words — "You wrote
 * about **drank 64 oz of water**. Check it off?" — while the accept logged the
 * goal's full target on today. Detection now extracts the amount and the
 * user-local day from the attesting span, so the card can state them and the
 * question becomes informed consent rather than a guess.
 *
 * Three rules hold this honest:
 *
 * - On a PENDING offer, a day the accept would refuse is **omitted**, not
 *   shown. The accept re-checks `completed_on` against the backfill window and
 *   silently logs today instead (`_in_window_day` / `_resolve_accept_day` in
 *   `backend/src/routers/journal.py`), so naming a 31-day-old date would
 *   promise something pressing OK does not do.
 * - On a SETTLED offer, the day is the one the server recorded as logged
 *   (`logged_on`), never re-derived from `completed_on` and the live clock
 *   (#2905): that re-derivation could name a day the accept never logged on,
 *   and dropped a backdated day once it aged out of the window. No window
 *   gate applies -- the day is a fact now, not a promise. A row with no
 *   recorded day (accepted before it was recorded) states no day at all.
 * - Both facts absent yields `null`, which is what keeps the fact-free copy
 *   byte-identical to what shipped before.
 *
 * Pure: no React, no store, no clock read. The caller supplies the unit it
 * resolved from the habit store and the user's today. "today"/"yesterday" on
 * a settled card is still relative to that live today, which is correct
 * because the day it is relative FROM is fixed.
 */
import type { CompletionSuggestion } from '@/api';
import { dayWindowVerdict } from '@/utils/backfillWindow';
import { DEFAULT_TIMEZONE, classifyDayAgainstToday } from '@/utils/dateUtils';

/** Middle dot with hair spaces either side — the card's own fact separator. */
export const FACT_SEPARATOR = ' · ';

/**
 * How a date that is neither today nor yesterday is written.
 *
 * `en-US` and `timeZone: 'UTC'` are both explicit. The locale, because the two
 * day labels already shipped in this app render `"Mon, Jan 5"` and a card that
 * followed the host's locale would print a third shape (on this repo's ICU,
 * `en-GB` renders `"Sept"`, not `"Sep"`). The zone, because the anchor below is
 * a UTC instant: without it a device east of UTC+12 would render the adjacent
 * calendar day.
 */
const DAY_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
};

/**
 * `"Mon, Sep 7"` for a `YYYY-MM-DD` key.
 *
 * Anchored at noon so the instant sits unambiguously inside its own day
 * whatever rounding the formatter does, the same anchor the habit log stepper
 * and the practice sheet use.
 */
const formatOtherDay = (dayKey: string): string =>
  new Date(`${dayKey}T12:00:00Z`).toLocaleDateString('en-US', DAY_FORMAT);

/** `"64 oz"`, or `"64"` when the goal's unit has not loaded. */
const amountSegment = (units: number, unit: string | null): string =>
  // `String` rather than `toFixed`: the field is a float end to end, so 64
  // must read "64" and 1.5 must read "1.5" — never "64.0".
  unit === null ? String(units) : `${String(units)} ${unit}`;

/** `"today"`, `"yesterday"` or `"Mon, Sep 7"` for a day, with no window gate. */
const namedDay = (dayKey: string, todayIso: string): string => {
  const relation = classifyDayAgainstToday(dayKey, todayIso, DEFAULT_TIMEZONE);
  if (relation === 'other') return formatOtherDay(dayKey);
  return relation;
};

/** The day as a pending card names it, or `null` when the accept would refuse it. */
const daySegment = (dayKey: string, todayIso: string): string | null => {
  if (dayWindowVerdict(dayKey, todayIso) !== 'ok') return null;
  return namedDay(dayKey, todayIso);
};

/** Join the present segments with the card's separator, or `null` if none. */
const joinFacts = (segments: Array<string | null>): string | null => {
  const present = segments.filter((segment): segment is string => segment !== null);
  return present.length === 0 ? null : present.join(FACT_SEPARATOR);
};

/**
 * The facts line for a suggestion, or `null` when there is nothing to state.
 *
 * @param suggestion - The offer, carrying the detected amount and day.
 * @param unit - The goal's `target_unit`, or `null` if the store has not
 *   loaded a server-backed row for `goal_id` yet.
 * @param todayIso - The user's today as `YYYY-MM-DD`.
 * @returns e.g. `"64 oz · yesterday"`, or `null`.
 */
export const describeSuggestionFacts = (
  suggestion: CompletionSuggestion,
  unit: string | null,
  todayIso: string,
): string | null => {
  const { completed_units: units, completed_on: day } = suggestion;
  return joinFacts([
    units === null ? null : amountSegment(units, unit),
    day === null ? null : daySegment(day, todayIso),
  ]);
};

/**
 * The facts line for a SETTLED (accepted) suggestion: the amount, and the day
 * the server recorded the accept as logging -- never `completed_on`.
 *
 * @param suggestion - The accepted row, carrying `logged_on`.
 * @param unit - The goal's `target_unit`, or `null` if not loaded yet.
 * @param todayIso - The user's today as `YYYY-MM-DD`; only labels the fixed day.
 * @returns e.g. `"64 oz · yesterday"`, `"64 oz"` for a row with no recorded
 *   day, or `null`.
 */
export const describeSettledFacts = (
  suggestion: CompletionSuggestion,
  unit: string | null,
  todayIso: string,
): string | null => {
  const { completed_units: units, logged_on: loggedOn } = suggestion;
  return joinFacts([
    units === null ? null : amountSegment(units, unit),
    loggedOn === null ? null : namedDay(loggedOn, todayIso),
  ]);
};

/**
 * The facts line a card shows: what OK will log while pending, what it did
 * log once accepted.
 *
 * @param suggestion - The offer, in any status.
 * @param unit - The goal's `target_unit`, or `null` if not loaded yet.
 * @param todayIso - The user's today as `YYYY-MM-DD`.
 * @returns The facts line, or `null` when there is nothing to state.
 */
export const describeCardFacts = (
  suggestion: CompletionSuggestion,
  unit: string | null,
  todayIso: string,
): string | null =>
  suggestion.status === 'accepted'
    ? describeSettledFacts(suggestion, unit, todayIso)
    : describeSuggestionFacts(suggestion, unit, todayIso);
