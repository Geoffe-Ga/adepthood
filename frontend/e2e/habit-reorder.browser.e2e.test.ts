import { expect, test } from '@playwright/test';

import {
  backendUrl,
  openHabits,
  openReorder,
  seedHabit,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * How long each reorder PUT is held open. Long enough that a save which does
 * not wait for its own writes loses by construction rather than by luck, and
 * short enough to sit well inside the per-assertion timeout.
 */
const REORDER_PUT_DELAY_MS = 1500;
const CANDLE_AND_INK_ACCENT = 'rgb(165, 87, 47)';
const BEIGE_STAGE = 'rgb(216, 203, 184)';

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

  // Hold every reorder PUT open. This spec used to press Save Order and ask the
  // server for the row immediately, with nothing truthful to wait on: the modal
  // dismissed the moment the writes were DISPATCHED, so the read below beat
  // them whenever the box was busy (#2755). With the writes deliberately slow,
  // the settle signal has to be real -- the modal now closes only once they
  // have landed, which is a fact about the app rather than about timing.
  await page.route(/\/habits\/\d+(?:\?|$)/u, async (route) => {
    if (route.request().method() === 'PUT') {
      await new Promise((resolve) => setTimeout(resolve, REORDER_PUT_DELAY_MS));
    }
    await route.continue();
  });

  await page.getByRole('button', { name: 'Save Order' }).click();
  // The act announces itself while it is outstanding...
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible();
  // ...and the modal closes when, and only when, the reorder has landed.
  await expect(page.getByTestId('reorder-modal-card')).toBeHidden();

  const saved = await page.request.get(`${backendUrl()}/habits/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(saved.ok()).toBe(true);
  const rows = (await saved.json()) as Array<{ id: number; is_carryover: boolean }>;
  expect(rows.find((habit) => habit.id === firstId)?.is_carryover).toBe(true);

  // Program habits keep their ranked spiral color after the cross-boundary
  // reorder. The carryover habit is deliberately unranked: its tile and
  // progress paint with one Candle & Ink accent rather than running the stage
  // gradient backwards.
  const programTile = page.getByTestId('habit-tile').filter({ hasText: 'Browser Habit Two' });
  await expect(programTile).toHaveCSS('border-color', BEIGE_STAGE);

  await page.getByTestId('pagination-prev').click();
  const carryoverTile = page.getByTestId('habit-tile').filter({ hasText: 'Browser Habit One' });
  await expect(carryoverTile).toHaveCSS('border-color', CANDLE_AND_INK_ACCENT);
  await expect(carryoverTile.getByTestId('progress-fill')).toHaveCSS(
    'background-color',
    CANDLE_AND_INK_ACCENT,
  );
});
