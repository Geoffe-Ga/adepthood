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

/** Milliseconds in one calendar day — the single source for day-span math. */
export const MS_PER_DAY = 86_400_000;

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

/** Wall-clock hour used to anchor a day-key instant clear of DST shoulders. */
const NOON_HOUR = 12;

/**
 * The zone's UTC offset (local minus UTC) in milliseconds at `instant`,
 * derived from the formatted wall-clock parts. DST-correct for that instant.
 */
const zoneOffsetMs = (instant: Date, tz: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const field: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') field[part.type] = Number.parseInt(part.value, 10);
  }
  // Intl can render midnight as hour 24; normalise it to 0.
  const hour = field.hour === 24 ? 0 : field.hour!;
  const wallAsUTC = Date.UTC(
    field.year!,
    field.month! - 1,
    field.day!,
    hour,
    field.minute!,
    field.second!,
  );
  return wallAsUTC - instant.getTime();
};

/**
 * Convert a `YYYY-MM-DD` day key into a UTC instant that falls on that day in
 * `tz`, anchored at local noon.
 *
 * The inverse of `dayKeyInTZ`: `dayKeyInTZ(dayKeyToInstant(k, tz), tz) === k`
 * for every real zone offset (UTC-12..UTC+14). Anchoring at local noon (rather
 * than the naive `${k}T00:00:00Z`, which lands on the previous day for
 * negative-offset zones and the next day for far-eastern ones) keeps the
 * instant unambiguously inside the target calendar day and clear of DST
 * shoulders. Use it when a day key must round-trip through a `Date` that later
 * gets re-bucketed in the same zone (e.g. persisted completion timestamps).
 */
export const dayKeyToInstant = (dayKey: string, tz: string): Date => {
  const [year, month, day] = dayKey.split('-').map((part) => Number.parseInt(part, 10));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day)
  ) {
    return new Date(`${dayKey}T00:00:00Z`);
  }
  const zone = resolveZone(tz);
  const wallNoonAsUTC = Date.UTC(year, month - 1, day, NOON_HOUR, 0, 0);
  const offsetMs = zoneOffsetMs(new Date(wallNoonAsUTC), zone);
  return new Date(wallNoonAsUTC - offsetMs);
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

export interface SubtractiveStreakInput {
  /** Completion log entries: timestamp + units logged on that timestamp. */
  completions: ReadonlyArray<{ timestamp: string | Date; completed_units: number }>;
  /** The clear-tier goal's target; a day's sum > this value breaks the streak. */
  clearThreshold: number;
  /** Habit's start date as `YYYY-MM-DD` in the user's TZ; the walk stops here. */
  startDate: string;
}

/**
 * Compute the streak for a subtractive habit (e.g. "abstain from sugar").
 *
 * For subtractive goals, *absence* of a log is the best possible
 * outcome — it means the user did not slip — so the additive helper's
 * "every counted day must have a row" model produces the wrong answer.
 * This helper walks backwards from `now` in the user's TZ:
 *
 *   - A day where the user's logged sum stays ≤ ``clearThreshold``
 *     counts as a streak day (no row at all maps to sum=0 = success).
 *   - The first day going back where the sum > ``clearThreshold`` is
 *     a transgression and breaks the chain.
 *   - The walk stops at ``startDate`` so the streak can never exceed
 *     the habit's life.
 *
 * Mirrors backend ``domain.streaks.subtractive_current_streak``
 * so the stats overlay and the tile-displayed ``habit.streak`` (which
 * comes from the backend's ``compute_habit_streak``) agree.
 */
export const subtractiveStreakFromCompletions = (
  input: SubtractiveStreakInput,
  tz: string,
  now: Date = new Date(),
): number => {
  const today = dayKeyInTZ(now, tz);
  if (input.startDate > today) return 0;

  const dayTotals = new Map<string, number>();
  for (const c of input.completions) {
    const key = dayKeyInTZ(c.timestamp, tz);
    dayTotals.set(key, (dayTotals.get(key) ?? 0) + c.completed_units);
  }

  let streak = 0;
  let cursor = today;
  while (cursor >= input.startDate) {
    const total = dayTotals.get(cursor) ?? 0;
    if (total > input.clearThreshold) break;
    streak += 1;
    cursor = addDaysInTZ(cursor, -1, tz);
  }
  return streak;
};

/**
 * Longest abstention run for a subtractive habit over its whole life.
 *
 * Walks the full ``[startDate, today]`` window in the user's TZ and
 * tracks the longest consecutive run of days that stayed within the
 * clear threshold.  Use this for the stats overlay's "longest streak"
 * field — the additive ``computeLongestStreak`` counts logged days,
 * which is the inverse of what a subtractive habit cares about and
 * produces a contradictory display (e.g. "Current: 30 · Longest: 0"
 * for a 30-day perfect abstention).
 *
 * Returns 0 when the habit has not started yet.  Walks ``cursor`` from
 * ``startDate`` forward to keep the run-tracking obvious; backwards
 * would produce the same number but the read is noisier.
 */
export const subtractiveLongestStreakFromCompletions = (
  input: SubtractiveStreakInput,
  tz: string,
  now: Date = new Date(),
): number => {
  const today = dayKeyInTZ(now, tz);
  if (input.startDate > today) return 0;

  const dayTotals = new Map<string, number>();
  for (const c of input.completions) {
    const key = dayKeyInTZ(c.timestamp, tz);
    dayTotals.set(key, (dayTotals.get(key) ?? 0) + c.completed_units);
  }

  let longest = 0;
  let run = 0;
  let cursor = input.startDate;
  while (cursor <= today) {
    if ((dayTotals.get(cursor) ?? 0) > input.clearThreshold) {
      run = 0;
    } else {
      run += 1;
      if (run > longest) longest = run;
    }
    cursor = addDaysInTZ(cursor, 1, tz);
  }
  return longest;
};
