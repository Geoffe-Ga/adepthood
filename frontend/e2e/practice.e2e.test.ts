import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { auth, practiceSessions, practices, setTokenGetter, userPractices } from '@/api';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';

// Stage 1 is the curriculum's entry point and the only stage a fresh account
// has unlocked; logging against any other one is 403 `stage_locked`.
const ENTRY_STAGE = 1;

const SESSION_MINUTES = 12;
const MS_PER_MINUTE = 60_000;
const ISO_DATE_LENGTH = 10;

// `domain.practice_insights.WEEKLY_HISTORY_WEEKS`: the rollup is always this
// many Monday-start buckets wide, oldest first.
const HISTORY_WEEKS = 8;
// `domain.practice_insights.WEEKLY_TARGET_SESSIONS` is 4, so one session is
// not a streak.
const NO_STREAK = 0;

// `Date#getUTCDay` counts from Sunday; shifting by six puts Monday at zero, so
// the remainder is "days since this week's Monday".
const DAYS_PER_WEEK = 7;
const SUNDAY_TO_MONDAY_SHIFT = 6;

const email = `e2e-practice-${randomUUID()}${EMAIL_DOMAIN}`;
const reflection = `The long-form note the sitting left behind — ${randomUUID()}`;
const insight = `The one line worth keeping — ${randomUUID()}`;

// The client sends wall-clock ISO timestamps and the server derives the
// duration from them, so a whole number of minutes out is a whole number back.
const endedAt = new Date();
const startedAt = new Date(endedAt.getTime() - SESSION_MINUTES * MS_PER_MINUTE);

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
 * the insights bucket on — a disagreement here is the timezone bug the
 * week-boundary math was rewritten to fix, not a test artefact.
 */
function utcWeekStart(instant: Date): string {
  const monday = new Date(instant);
  const sinceMonday = (monday.getUTCDay() + SUNDAY_TO_MONDAY_SHIFT) % DAYS_PER_WEEK;
  monday.setUTCDate(monday.getUTCDate() - sinceMonday);
  return monday.toISOString().slice(0, ISO_DATE_LENGTH);
}

describe('practice session-logging journey against a live server', () => {
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

    expect(chosen.stage_number).toBe(ENTRY_STAGE);
    expect(chosen.approved).toBe(true);

    const adopted = await userPractices.create({
      practice_id: chosen.id,
      stage_number: ENTRY_STAGE,
    });

    expect(adopted.id).toBeGreaterThan(0);
    expect(adopted.practice_id).toBe(chosen.id);
    expect(adopted.stage_number).toBe(ENTRY_STAGE);
    // Still the open selection: an adoption that closed itself would make the
    // session below unloggable.
    expect(adopted.end_date).toBeNull();

    userPracticeId = adopted.id;
    // Denormalised onto the session at write time, so the value the catalog
    // gave us is what the log below has to come back carrying.
    practiceMode = required(chosen.mode, `mode on the practice "${chosen.name}"`);
  });

  it('counts an empty week before the practitioner has sat down', async () => {
    const before = await practiceSessions.weekCount();

    // Exact envelope: the count has to be zero *because nothing is logged*,
    // which is what makes the same call meaningful after the write.
    expect(before).toEqual({ count: 0 });
  });

  it('logs a session and gets the server-derived reckoning of it back', async () => {
    const logged = await practiceSessions.create({
      user_practice_id: userPracticeId,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      reflection,
      insight,
    });

    expect(logged.id).toBeGreaterThan(0);
    expect(logged.user_practice_id).toBe(userPracticeId);
    // Never sent by the client: the server subtracts the two timestamps.
    expect(logged.duration_minutes).toBe(SESSION_MINUTES);
    expect(logged.mode).toBe(practiceMode);
    expect(logged.reflection).toBe(reflection);
    expect(logged.insight).toBe(insight);
    expect(logged.completed).toBe(true);
    // The instant survives the round trip through a timezone-aware column.
    expect(Date.parse(logged.timestamp)).toBe(endedAt.getTime());
  });

  it('counts the session in the week the practitioner is standing in', async () => {
    const after = await practiceSessions.weekCount();

    expect(after).toEqual({ count: 1 });
  });

  it('rolls the session into the insights the Practice screen reads', async () => {
    const rollup = await practiceSessions.insights();

    expect(rollup.weekly_counts).toHaveLength(HISTORY_WEEKS);

    const thisWeek = required(rollup.weekly_counts.at(-1), 'weekly bucket');
    expect(thisWeek.week_start).toBe(utcWeekStart(endedAt));
    expect(thisWeek.count).toBe(1);
    // Every earlier bucket stays empty: the one session landed in one week.
    expect(rollup.weekly_counts.slice(0, -1).map((bucket) => bucket.count)).toEqual(
      Array.from({ length: HISTORY_WEEKS - 1 }, () => 0),
    );

    expect(rollup.streak_weeks).toBe(NO_STREAK);
    expect(rollup.total_minutes_30d).toBe(SESSION_MINUTES);
    expect(rollup.avg_duration_minutes_30d).toBe(SESSION_MINUTES);
    expect(rollup.per_mode_counts).toEqual({ [practiceMode]: 1 });
    expect(rollup.last_insight).toBe(insight);
  });
});
