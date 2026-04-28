/**
 * Date / timezone helpers — single source of truth for user-local day math.
 *
 * Mirrors the backend's `domain.dates` module: every screen that needs to
 * know "what day is it for this user?" should ask `todayInUserTZ` rather
 * than re-deriving from `new Date().toISOString().slice(0, 10)`. Mixing
 * the two surfaces the off-by-one boundary bug (BUG-FE-HABIT-002,
 * BUG-FE-HABIT-206, BUG-FE-HABIT-207): a habit completed at 11:30 PM
 * Pacific is recorded with a UTC timestamp that the naive `.toISOString`
 * call labels as the *next* day, so the streak ticks over prematurely
 * on the West Coast and unlock countdowns are off by one.
 *
 * Every helper takes the user's IANA timezone (`tz`) as an argument
 * rather than reading `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * at the call site so a profile-edited zone takes effect immediately
 * without screens caching the device's resolved zone.
 *
 * Output shape: every public helper that returns a "day key" returns the
 * `YYYY-MM-DD` form, which sorts lexicographically and matches the
 * backend's serialised `date` columns.
 */

/**
 * Default IANA timezone used when the caller does not yet have a value
 * (e.g. an unauthenticated screen, or a freshly-installed app before the
 * user object loads). Mirrors the backend's `User.DEFAULT_USER_TIMEZONE`.
 */
export const DEFAULT_TIMEZONE = 'UTC';

/**
 * Resolve a likely-valid IANA zone, falling back to UTC on error.
 *
 * `Intl.DateTimeFormat` throws on a malformed `timeZone` argument, which
 * would crash a screen rendering with bad user input.  Catching once
 * here lets every other helper assume it has a working zone.
 */
const resolveZone = (tz: string | null | undefined): string => {
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

/**
 * Detect the device's IANA timezone for sending on signup.
 *
 * Prefer reading from a stored user record; this helper is for the brief
 * window before the user has chosen their zone (signup) where we want a
 * sensible default.
 */
export const detectDeviceTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

/**
 * Return today's calendar date in `YYYY-MM-DD` form for the given TZ.
 *
 * Uses `en-CA` because that locale formats as `YYYY-MM-DD` with no
 * separator surprises across browsers — exactly what we need for
 * lexicographic sorting and equality checks against backend values.
 */
export const todayInUserTZ = (tz: string): string => {
  const zone = resolveZone(tz);
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
};

/**
 * Convert any moment to its `YYYY-MM-DD` calendar date in the user's TZ.
 *
 * Accepts either a `Date` or an ISO-8601 string (the shape backend
 * timestamp fields use over the wire).  Strings already in `YYYY-MM-DD`
 * form are returned verbatim — they have no time component to convert
 * and are presumed already in the user's local calendar.
 */
export const dayKeyInTZ = (moment: Date | string, tz: string): string => {
  if (typeof moment === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(moment)) {
    return moment;
  }
  const date = moment instanceof Date ? moment : new Date(moment);
  const zone = resolveZone(tz);
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(date);
};

/**
 * Render the human-friendly day-of-week label for a `YYYY-MM-DD` key.
 *
 * Used by stats charts so a Sunday-night Pacific completion is labeled
 * "Sun" (the user's perception) rather than "Mon" (UTC after midnight).
 * Returns three-letter English labels matching the backend's
 * `_DAY_LABELS` constant.
 *
 * Implementation note: the calendar weekday for a `YYYY-MM-DD` key is
 * canonical (2026-06-15 is a Monday everywhere — the weekday derives
 * from the date itself, not the user's clock).  The `tz` parameter is
 * accepted for API symmetry with the other helpers but is intentionally
 * unused: an earlier version that re-formatted in the user's zone gave
 * incorrect results in *both* directions — `T12:00:00Z` printed as the
 * next day in UTC+13/+14, while `T00:00:00Z` printed as the prior day
 * in negative-offset zones.  Treating the day-key's weekday as zone-
 * independent is the only formulation that's correct everywhere.
 */
export const dayLabel = (dayKey: string, _tz: string): string => {
  const [year, month, day] = dayKey.split('-').map((part) => Number.parseInt(part, 10));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day)
  ) {
    return '';
  }
  const utcMidnight = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(utcMidnight);
};

/**
 * Add `days` calendar days to `dayKey` and return the new `YYYY-MM-DD` key.
 *
 * Pure calendar math via `Date.UTC` rather than wall-clock arithmetic
 * because day-key offsets do not interact with DST or zone choice — a
 * "calendar day" is a calendar day everywhere.  An earlier implementation
 * anchored at noon UTC and added `days * MS_PER_DAY`, which broke for
 * users east of UTC+11: noon UTC maps to 02:00 the *next* day in
 * Pacific/Kiritimati (UTC+14), so the result printed one day off and
 * `streakFromCompletions` reported every NZ/Samoa/Kiritimati streak
 * as 1 regardless of history.
 *
 * The `tz` parameter is preserved for API stability so callers can
 * keep passing the user's zone without thinking about whether the
 * helper internally needs it.
 */
export const addDaysInTZ = (dayKey: string, days: number, _tz: string): string => {
  const [year, month, day] = dayKey.split('-').map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined) {
    return dayKey;
  }
  // ``Date.UTC`` handles month / year rollover correctly for any positive
  // or negative day delta; UTC has no DST, so the offset is exact.
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
};

/**
 * Compute the user's current streak from completion timestamps.
 *
 * Closes BUG-FE-HABIT-207: the previous implementation never compared
 * the most recent completion to "today", so a user who completed every
 * day for a month then missed today still saw their full streak.  This
 * helper:
 *
 *   1. Buckets timestamps into user-local calendar days.
 *   2. Sorts unique days descending.
 *   3. Counts consecutive days walking backwards from today (or the
 *      most recent day, whichever is more recent — a missed day at the
 *      front of the sequence breaks the streak immediately).
 *
 * @param timestamps ISO-8601 strings (or `YYYY-MM-DD` keys) of completions
 * @param tz user's IANA timezone
 * @param now optional override for "today", primarily for tests
 */
export const streakFromCompletions = (
  timestamps: ReadonlyArray<string | Date>,
  tz: string,
  now: Date = new Date(),
): number => {
  if (timestamps.length === 0) return 0;
  const today = dayKeyInTZ(now, tz);
  const dayKeys = new Set<string>();
  for (const ts of timestamps) {
    dayKeys.add(dayKeyInTZ(ts, tz));
  }
  // Sort descending so we walk most-recent first.
  const sorted = Array.from(dayKeys).sort().reverse();
  // The streak is broken if the most recent completion is older than
  // yesterday — a single missed day zeros it.
  const yesterday = addDaysInTZ(today, -1, tz);
  if (sorted[0] !== today && sorted[0] !== yesterday) {
    return 0;
  }
  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const expected = addDaysInTZ(sorted[i - 1]!, -1, tz);
    if (sorted[i] !== expected) break;
    streak += 1;
  }
  return streak;
};
