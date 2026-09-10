import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { auth, goalCompletions, habits, setTokenGetter } from '@/api';
import type { ApiHabitWithGoals } from '@/api';

/**
 * Deleting a habit that has been lived with, against a real Postgres.
 *
 * The backend suite runs on SQLite built from the model metadata; until #2763
 * it was not even enforcing foreign keys, so nothing on that side could observe
 * whether `DELETE /habits/{id}` had cascaded or merely claimed to. The failure
 * this journey pins needed a completion row to exist before it appeared at all:
 * a habit created moments ago deleted cleanly, and one that had ever been
 * checked in returned 500, because the ORM nullified `goalcompletion.goal_id`
 * instead of letting the constraint remove the row. So the order here is the
 * whole point -- check in first, delete second.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();
const ISO_DATE_LENGTH = 10;

const ENERGY_COST = 3;
const ENERGY_RETURN = 4;
const HABIT_ICON = 'candle';
const CLEAR_TIER = 'clear';

const email = `e2e-habit-delete-${randomUUID()}${EMAIL_DOMAIN}`;
const habitName = `E2E Delete Habit ${randomUUID()}`;
const today = new Date().toISOString().slice(0, ISO_DATE_LENGTH);

describe('deleting a habit with history against a live server', () => {
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

  it('creates a habit and checks it in, so the delete has something to cascade', async () => {
    const created = await habits.create({
      name: habitName,
      icon: HABIT_ICON,
      start_date: today,
      energy_cost: ENERGY_COST,
      energy_return: ENERGY_RETURN,
    });
    habitId = created.id;
    expect(habitId).toBeGreaterThan(0);

    // The create response carries no goals; the list read is where they surface.
    const listed: ApiHabitWithGoals[] = await habits.listAll();
    const withGoals = listed.find((candidate) => candidate.id === habitId);
    if (withGoals === undefined) throw new Error('the habit just created is not in the list');
    const clearGoal = withGoals.goals.find((goal) => goal.tier === CLEAR_TIER);
    if (clearGoal === undefined) throw new Error('the server seeds no clear goal');
    clearGoalId = clearGoal.id;

    const checkIn = await goalCompletions.create({ goal_id: clearGoalId, did_complete: true });
    expect(checkIn.streak).toBe(1);
  });

  it('confirms the history is really there before the delete is asked for', async () => {
    const listed = await habits.listAll();

    const habit = listed.find((candidate) => candidate.id === habitId);
    if (habit === undefined) throw new Error('the habit just created is not in the list');
    expect(habit.streak).toBe(1);

    const clearGoal = habit.goals.find((goal) => goal.id === clearGoalId);
    expect(clearGoal?.completions ?? []).toHaveLength(1);
  });

  it('deletes the habit, and it stays deleted', async () => {
    await expect(habits.delete(habitId)).resolves.toBeUndefined();

    // The reported symptom was a tile that came back: the client reverts its
    // optimistic removal when the server rejects. A re-read is what the user's
    // next screen does, so it is what proves the row is gone rather than the
    // response merely having looked right.
    const afterDelete = await habits.listAll();
    expect(afterDelete.map((habit) => habit.id)).not.toContain(habitId);

    // The goals went with it. A habit row deleted while its goals survived
    // would still pass the list assertion above, and would orphan every
    // completion hanging off them.
    await expect(habits.getStats(habitId)).rejects.toMatchObject({ status: 404 });
  });
});
