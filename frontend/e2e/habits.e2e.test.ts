import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { ApiError, auth, goalCompletions, habits, setTokenGetter } from '@/api';
import type { ApiGoal, ApiHabitWithGoals } from '@/api';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();
const ISO_DATE_LENGTH = 10;
const HTTP_UNPROCESSABLE_CONTENT = 422;
const DAYS_PER_WEEK = 7;
// The day's settled units after the dedupe-and-correct sequence below.
const LOGGED_UNITS = 10;

const ENERGY_COST = 2;
const ENERGY_RETURN = 5;
const HABIT_ICON = 'candle';
const LOW_TIER = 'low';
const CLEAR_TIER = 'clear';
// The three tiers the server seeds with every habit, sorted for comparison.
const EXPECTED_TIERS = ['clear', 'low', 'stretch'];

const email = `e2e-habits-${randomUUID()}${EMAIL_DOMAIN}`;
// Non-ASCII is deliberate: canonicalization must not flatten visible Unicode.
const habitName = `E2E Hábito 道 ${randomUUID()}`;
// The account's timezone is UTC, so the server's "today" is this calendar day.
const today = new Date().toISOString().slice(0, ISO_DATE_LENGTH);

/** Unwrap a collection the journey requires to hold exactly one element. */
function exactlyOne<T>(items: readonly T[], what: string): T {
  const [first] = items;
  if (items.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one ${what}, got ${items.length}`);
  }
  return first;
}

function goalForTier(goals: readonly ApiGoal[], tier: string): ApiGoal {
  const match = goals.find((goal) => goal.tier === tier);
  if (match === undefined) {
    throw new Error(
      `no "${tier}" goal on the habit; tiers were ${goals.map((g) => g.tier).join()}`,
    );
  }
  return match;
}

/** Resolve with the request's error, and fail if an expected refusal resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('habits journey against a live server', () => {
  let sessionToken: string | null = null;
  let habitId = 0;
  let lowGoalId = 0;
  let clearGoalId = 0;

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

  it('refuses an invisible habit name without creating a habit or default goals', async () => {
    const failure = await rejection(
      habits.create({
        name: ' \u200b\u00ad\u061c\u0000\t\n ',
        icon: HABIT_ICON,
        start_date: today,
        energy_cost: ENERGY_COST,
        energy_return: ENERGY_RETURN,
      }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNPROCESSABLE_CONTENT);
    expect((failure as ApiError).detail).toBe('habit_name_empty');
    expect(await habits.listAll()).toEqual([]);
  });

  it('creates a habit and echoes back every field it was given', async () => {
    const created = await habits.create({
      name: `  ${habitName}\u200b  `,
      icon: HABIT_ICON,
      start_date: today,
      energy_cost: ENERGY_COST,
      energy_return: ENERGY_RETURN,
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.name).toBe(habitName);
    expect(created.icon).toBe(HABIT_ICON);
    expect(created.start_date).toBe(today);
    expect(created.energy_cost).toBe(ENERGY_COST);
    expect(created.energy_return).toBe(ENERGY_RETURN);

    habitId = created.id;
  });

  it('lists the habit back through the Page envelope with its three default goals', async () => {
    const listed: ApiHabitWithGoals[] = await habits.listAll();

    const habit = exactlyOne(listed, 'habit on the fresh account');
    expect(habit.id).toBe(habitId);
    expect(habit.name).toBe(habitName);
    expect(habit.streak).toBe(0);
    expect(habit.goals.map((goal) => goal.tier).sort()).toEqual(EXPECTED_TIERS);
    for (const goal of habit.goals) {
      expect(goal.habit_id).toBe(habitId);
      expect(goal.completions ?? []).toHaveLength(0);
    }

    lowGoalId = goalForTier(habit.goals, LOW_TIER).id;
    clearGoalId = goalForTier(habit.goals, CLEAR_TIER).id;
  });

  it('deduplicates one act and corrects across tier rows over the real wire', async () => {
    const firstOperation = `log-unit:${randomUUID()}`;
    const ten = await goalCompletions.create(
      { goal_id: lowGoalId, did_complete: true, completed_units: 10 },
      { idempotencyKey: firstOperation },
    );
    const replayedTen = await goalCompletions.create(
      { goal_id: lowGoalId, did_complete: true, completed_units: 10 },
      { idempotencyKey: firstOperation },
    );
    const fifteen = await goalCompletions.create(
      { goal_id: clearGoalId, did_complete: true, completed_units: 5 },
      { idempotencyKey: `log-unit:${randomUUID()}` },
    );
    const seven = await goalCompletions.create(
      { goal_id: clearGoalId, did_complete: true, completed_units: -8 },
      { idempotencyKey: `log-unit:${randomUUID()}` },
    );
    const restoredFifteen = await goalCompletions.create(
      { goal_id: clearGoalId, did_complete: true, completed_units: 8 },
      { idempotencyKey: `log-unit:${randomUUID()}` },
    );
    const zero = await goalCompletions.create(
      { goal_id: clearGoalId, did_complete: true, completed_units: -99 },
      { idempotencyKey: `log-unit:${randomUUID()}` },
    );
    const restoredTen = await goalCompletions.create(
      { goal_id: clearGoalId, did_complete: true, completed_units: 10 },
      { idempotencyKey: `log-unit:${randomUUID()}` },
    );

    expect(ten.streak).toBe(1);
    expect(ten.reason_code).toBe('streak_incremented');
    expect(ten.milestones.map((milestone) => milestone.threshold)).toEqual([1]);
    expect(ten.day_units).toBe(10);
    expect(replayedTen.day_units).toBe(10);
    expect(fifteen.reason_code).toBe('units_adjusted');
    expect(fifteen.day_units).toBe(15);
    expect(seven.reason_code).toBe('units_adjusted');
    expect(seven.day_units).toBe(7);
    expect(restoredFifteen.day_units).toBe(15);
    expect(zero.day_units).toBe(0);
    expect(restoredTen.day_units).toBe(10);
  });

  it('reports the check-in in the habit story', async () => {
    const story = await habits.getStory(habitId);

    expect(story.today).toBe(today);
    expect(story.continuity.current_run).toBe(1);
    expect(story.continuity.longest_run).toBe(1);
    // One day logged, however many corrections it took to settle its units.
    expect(story.logged_days).toBe(1);
    const loggedDays = story.days.filter((day) => day.logged);
    expect(loggedDays.map((day) => day.date)).toEqual([today]);
    expect(loggedDays[0]?.units).toBe(LOGGED_UNITS);
    // The weekday pattern and the calendar are one history: a drift between
    // them is a wire bug.
    expect(story.patterns.weekday_units).toHaveLength(DAYS_PER_WEEK);
    expect(story.patterns.weekday_units.reduce((sum, units) => sum + units, 0)).toBe(LOGGED_UNITS);
  });

  it('shows the streak and the embedded completion on a fresh list', async () => {
    const listed = await habits.listAll();

    const habit = exactlyOne(listed, 'habit on the fresh account');
    expect(habit.streak).toBe(1);

    const clearGoal = goalForTier(habit.goals, CLEAR_TIER);
    const completion = exactlyOne(clearGoal.completions ?? [], 'completion on the clear goal');
    expect(completion.id).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(completion.timestamp))).toBe(false);
    expect(completion.completed_units).toBe(10);

    const lowGoal = goalForTier(habit.goals, LOW_TIER);
    const correctedLow = exactlyOne(
      lowGoal.completions ?? [],
      'corrected completion on the low goal',
    );
    expect(correctedLow.completed_units).toBe(0);
    expect(goalForTier(habit.goals, 'stretch').completions ?? []).toHaveLength(0);
  });
});
