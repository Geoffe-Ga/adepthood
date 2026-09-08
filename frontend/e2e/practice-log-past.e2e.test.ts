import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { auth, practiceSessions, practices, setTokenGetter, userPractices } from '@/api';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
// One Gumroad sale binds to exactly one active account (ADR 0008), so every
// journey that registers has to mint its own key.
const LICENSE_KEY = freshLicenseKey();

// Stage 1 is the curriculum's entry point and the only stage a fresh account
// has unlocked; logging against any other one is 403 `stage_locked`.
const ENTRY_STAGE = 1;

// A sitting done on a cushion three hours ago — inside the backend's 24-hour
// backdate window (`schemas.practice.MAX_BACKDATE_WINDOW`) and well under its
// 8-hour duration cap, which is exactly what the sheet's client-side guards
// let a person choose.
const PAST_SESSION_MINUTES = 20;
const PAST_END_HOURS_AGO = 3;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const ISO_DATE_LENGTH = 10;

// `domain.practice_insights.WEEKLY_HISTORY_WEEKS`: the rollup is always this
// many Monday-start buckets wide, oldest first.
const HISTORY_WEEKS = 8;

// `Date#getUTCDay` counts from Sunday; shifting by six puts Monday at zero, so
// the remainder is "days since this week's Monday".
const DAYS_PER_WEEK = 7;
const SUNDAY_TO_MONDAY_SHIFT = 6;

const email = `e2e-practice-log-past-${randomUUID()}${EMAIL_DOMAIN}`;

// The window the manual-log form would build for "3 hours ago, 20 minutes".
// `duration_minutes` is never sent: the server subtracts these two.
const endedAt = new Date(Date.now() - PAST_END_HOURS_AGO * MINUTES_PER_HOUR * MS_PER_MINUTE);
const startedAt = new Date(endedAt.getTime() - PAST_SESSION_MINUTES * MS_PER_MINUTE);

/** Unwrap a value the journey cannot continue without. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`the server returned no ${what}`);
  }
  return value;
}

/**
 * ISO date of the Monday on or before `instant`, in UTC.
 *
 * The account's timezone is UTC, so this is the same Monday the server anchors
 * the insights bucket on. Anchoring on the *chosen end time's* own week rather
 * than on "now" is what makes the assertion below safe across a Monday
 * boundary: a backdated sitting belongs to the week it happened in.
 */
function utcWeekStart(instant: Date): string {
  const monday = new Date(instant);
  const sinceMonday = (monday.getUTCDay() + SUNDAY_TO_MONDAY_SHIFT) % DAYS_PER_WEEK;
  monday.setUTCDate(monday.getUTCDate() - sinceMonday);
  return monday.toISOString().slice(0, ISO_DATE_LENGTH);
}

describe('logging a past practice session against a live server', () => {
  let sessionToken: string | null = null;
  let userPracticeId = 0;
  let practiceMode = '';

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can perturb it', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(response.user_id).toBeGreaterThan(0);

    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
  });

  it('adopts a practice from the stage the fresh account has unlocked', async () => {
    const catalog = await practices.listAll(ENTRY_STAGE);
    const chosen = required(catalog[0], `practice in the stage-${ENTRY_STAGE} catalog`);

    const adopted = await userPractices.create({
      practice_id: chosen.id,
      stage_number: ENTRY_STAGE,
    });

    expect(adopted.id).toBeGreaterThan(0);
    expect(adopted.end_date).toBeNull();

    userPracticeId = adopted.id;
    practiceMode = required(chosen.mode, `mode on the practice "${chosen.name}"`);
  });

  it('accepts a sitting that ended hours ago, with no timer run behind it', async () => {
    const logged = await practiceSessions.create({
      user_practice_id: userPracticeId,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      completed: true,
    });

    expect(logged.id).toBeGreaterThan(0);
    expect(logged.user_practice_id).toBe(userPracticeId);
    // Derived by the server from the two timestamps the form chose — the whole
    // point of sending a window rather than a duration.
    expect(logged.duration_minutes).toBe(PAST_SESSION_MINUTES);
    expect(logged.completed).toBe(true);
    // The sitting is stamped when it *ended*, not when it was recorded.
    expect(Date.parse(logged.timestamp)).toBe(endedAt.getTime());
    expect(logged.mode).toBe(practiceMode);
    // No engine ran, so there is nothing to harvest.
    expect(logged.mode_metadata).toBeNull();
    expect(logged.reflection).toBeNull();
    expect(logged.insight).toBeNull();
  });

  it('counts the sitting in the week it happened in, not the week it was typed in', async () => {
    const rollup = await practiceSessions.insights();

    expect(rollup.weekly_counts).toHaveLength(HISTORY_WEEKS);

    const itsWeek = utcWeekStart(endedAt);
    const buckets = rollup.weekly_counts;
    const matching = buckets.filter((bucket) => bucket.week_start === itsWeek);
    expect(matching).toHaveLength(1);
    expect(required(matching[0], 'bucket for the session week').count).toBe(1);
    // Every other week stays empty: one sitting lands in exactly one week.
    expect(
      buckets.filter((bucket) => bucket.week_start !== itsWeek).map((bucket) => bucket.count),
    ).toEqual(Array.from({ length: HISTORY_WEEKS - 1 }, () => 0));

    expect(rollup.total_minutes_30d).toBe(PAST_SESSION_MINUTES);
    expect(rollup.per_mode_counts).toEqual({ [practiceMode]: 1 });
  });
});
