import { expect, test } from '@playwright/test';

import { backendUrl, bearer, openHabits, signUp, tokenFor } from './journalHabitsBrowserSupport';

import type { ApiGoal, ApiHabitWithGoals, GoalUpdatePayload } from '@/api';

const USER_TIMEZONE = 'America/Los_Angeles';
const HABIT_NAME = 'No late-night scrolling';

test.use({ timezoneId: USER_TIMEZONE });

const todayInZone = (zone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());

const targetFor = (goal: ApiGoal): number => {
  if (goal.tier === 'low') return 30;
  if (goal.tier === 'clear') return 10;
  return 0;
};

const subtractivePayload = (goal: ApiGoal): GoalUpdatePayload => ({
  title: goal.title,
  description: goal.description ?? null,
  tier: goal.tier,
  target: targetFor(goal),
  target_unit: 'minutes',
  frequency: goal.frequency,
  frequency_unit: goal.frequency_unit,
  is_additive: false,
  goal_group_id: goal.goal_group_id ?? null,
  days_of_week: goal.days_of_week ?? null,
});

test('a new subtractive habit shows its no-log streak on the real tile', async ({ page }) => {
  const email = await signUp(page, 'subtractive-no-log-streak');
  const token = await tokenFor(page.request, email);
  const headers = bearer(token);

  const created = await page.request.post(`${backendUrl()}/habits/`, {
    headers,
    data: {
      name: HABIT_NAME,
      icon: '🌙',
      start_date: todayInZone(USER_TIMEZONE),
      energy_cost: 2,
      energy_return: 6,
      revealed: true,
    },
  });
  expect(created.ok()).toBe(true);

  const initial = await page.request.get(`${backendUrl()}/habits/`, { headers });
  expect(initial.ok()).toBe(true);
  const rows = (await initial.json()) as ApiHabitWithGoals[];
  const habit = rows.find((row) => row.name === HABIT_NAME);
  expect(habit).toBeDefined();

  for (const goal of habit?.goals ?? []) {
    const updated = await page.request.put(`${backendUrl()}/goals/${String(goal.id)}`, {
      headers,
      data: subtractivePayload(goal),
    });
    expect(updated.ok()).toBe(true);
  }

  const classified = await page.request.get(`${backendUrl()}/habits/`, { headers });
  expect(classified.ok()).toBe(true);
  const classifiedRows = (await classified.json()) as ApiHabitWithGoals[];
  expect(classifiedRows.find((row) => row.name === HABIT_NAME)?.streak).toBe(1);

  await page.reload();
  await openHabits(page);

  const tile = page.getByTestId('habit-tile').filter({ hasText: HABIT_NAME });
  await expect(tile).toBeVisible();
  await expect(tile).toContainText('1 DAYS — ACHIEVED TODAY!');
});
