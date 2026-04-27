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

const MS_PER_DAY = 86_400_000;

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
 * Render the human-friendly day-of-week label for a `YYYY-MM-DD` key in TZ.
 *
 * Used by stats charts so a Sunday-night Pacific completion is labeled
 * "Sun" (the user's perception) rather than "Mon" (UTC after midnight).
 * Returns three-letter English labels matching the backend's
 * `_DAY_LABELS` constant.
 */
export const dayLabel = (dayKey: string, tz: string): string => {
  const zone = resolveZone(tz);
  // Anchor at noon to avoid DST shoulder-day rendering artefacts.
  const midday = new Date(`${dayKey}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: zone,
  }).format(midday);
};

/**
 * Add `days` calendar days to `dayKey` and return the new `YYYY-MM-DD` key.
 *
 * Calendar-safe replacement for the old `setUTCDate(d.getUTCDate() + n)`
 * pattern that drifted across DST boundaries.  Operates on day strings
 * rather than `Date` objects so consumers cannot accidentally re-introduce
 * UTC drift by mixing `getTime()` arithmetic with local-zone reads.
 */
export const addDaysInTZ = (dayKey: string, days: number, tz: string): string => {
  const zone = resolveZone(tz);
  const anchor = new Date(`${dayKey}T12:00:00Z`);
  anchor.setTime(anchor.getTime() + days * MS_PER_DAY);
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(anchor);
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
