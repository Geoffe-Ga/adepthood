import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { auth, goalCompletions, habits, setTokenGetter } from '@/api';
import type { ApiGoal, ApiHabitWithGoals } from '@/api';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const ISO_DATE_LENGTH = 10;

const ENERGY_COST = 2;
const ENERGY_RETURN = 5;
const HABIT_ICON = 'candle';
const CLEAR_TIER = 'clear';
// The three tiers the server seeds with every habit, sorted for comparison.
const EXPECTED_TIERS = ['clear', 'low', 'stretch'];

const email = `e2e-habits-${randomUUID()}${EMAIL_DOMAIN}`;
const habitName = `E2E Habit ${randomUUID()}`;
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

describe('habits journey against a live server', () => {
  let sessionToken: string | null = null;
  let habitId = 0;
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

  it('creates a habit and echoes back every field it was given', async () => {
    const created = await habits.create({
      name: habitName,
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

    clearGoalId = goalForTier(habit.goals, CLEAR_TIER).id;
  });

  it('records a check-in on the clear goal and starts the streak', async () => {
    const result = await goalCompletions.create({ goal_id: clearGoalId, did_complete: true });

    expect(result.streak).toBe(1);
    expect(result.reason_code).toBe('streak_incremented');
    expect(result.milestones.map((milestone) => milestone.threshold)).toEqual([1]);
  });

  it('reports the check-in in the habit stats', async () => {
    const stats = await habits.getStats(habitId);

    expect(stats.current_streak).toBe(1);
    expect(stats.longest_streak).toBe(1);
    expect(stats.total_completions).toBe(1);
    expect(stats.completion_rate).toBe(1);
    expect(stats.completion_dates).toEqual([today]);
    // The three series are one chart: a drift between them is a wire bug.
    expect(stats.day_labels.length).toBeGreaterThan(0);
    expect(stats.values).toHaveLength(stats.day_labels.length);
    expect(stats.completions_by_day).toHaveLength(stats.day_labels.length);
  });

  it('shows the streak and the embedded completion on a fresh list', async () => {
    const listed = await habits.listAll();

    const habit = exactlyOne(listed, 'habit on the fresh account');
    expect(habit.streak).toBe(1);

    const clearGoal = goalForTier(habit.goals, CLEAR_TIER);
    const completion = exactlyOne(clearGoal.completions ?? [], 'completion on the clear goal');
    expect(completion.id).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(completion.timestamp))).toBe(false);

    // Only the tier that was checked in carries a completion.
    for (const goal of habit.goals.filter((candidate) => candidate.id !== clearGoalId)) {
      expect(goal.completions ?? []).toHaveLength(0);
    }
  });
});
