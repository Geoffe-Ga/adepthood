import { expect, test } from '@playwright/test';

import {
  backendUrl,
  openHabits,
  openReorder,
  seedHabit,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

test('a real pointer drag reorders a habit across the program boundary and persists it', async ({
  page,
}) => {
  const email = await signUp(page, 'reorder-real-drag');
  const token = await tokenFor(page.request, email);
  const firstId = await seedHabit(page.request, token, 'Browser Habit One');
  await seedHabit(page.request, token, 'Browser Habit Two');
  await page.reload();
  await openHabits(page);
  await openReorder(page);

  const source = page.getByRole('listitem', { name: /Move Browser Habit One/ });
  const negativeRange = page.locator('[data-range-page="-1"]');
  await source.dragTo(negativeRange);

  await expect(source).toHaveAttribute('aria-label', /position -1/);
  await page.getByRole('button', { name: 'Save Order' }).click();

  const saved = await page.request.get(`${backendUrl()}/habits/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(saved.ok()).toBe(true);
  const rows = (await saved.json()) as Array<{ id: number; is_carryover: boolean }>;
  expect(rows.find((habit) => habit.id === firstId)?.is_carryover).toBe(true);
});
