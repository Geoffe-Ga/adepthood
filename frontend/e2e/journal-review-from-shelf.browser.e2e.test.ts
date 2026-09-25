import { expect, test } from '@playwright/test';

import {
  backendUrl,
  setProgramAnchorDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/** Program day 7: the first week closes, so its review is the shelf's call to write. */
const DAY_SEVEN = 6;
/** Program day 9: nothing is due, but the second week, stage 1, section 1 and the course are open. */
const DAY_NINE = 8;

interface SavedEntry {
  id: number;
  tag: string;
  reflection_level: string | null;
  reflection_scope_key: string | null;
}

test('on a review day the shelf’s one call to write is the Weekly Review', async ({ page }) => {
  const email = await signUp(page, 'review-cta-day-seven');
  setProgramAnchorDaysAgo(email, DAY_SEVEN);
  await page.reload();

  const cta = page.getByRole('button', { name: /^Write your Weekly Review/ });
  await expect(cta).toBeVisible();
  // One primary invitation: the daily page steps aside while the review is offered.
  await expect(page.getByRole('button', { name: 'Begin a morning page' })).toHaveCount(0);
  await cta.click();

  await expect(page.getByRole('textbox', { name: 'Entry title' })).toHaveValue(
    'Weekly Review — Week 1',
  );
});

test('a review can be begun early from the shelf on a day nothing is due', async ({ page }) => {
  const email = await signUp(page, 'review-early-day-nine');
  const token = await tokenFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  setProgramAnchorDaysAgo(email, DAY_NINE);
  await page.reload();

  // Nothing is due on day 9, so the daily page holds the primary slot.
  await expect(page.getByRole('button', { name: 'Begin a morning page' })).toBeVisible();
  await expect(page.getByTestId('journal-reflection-band')).toHaveCount(0);

  await page.getByRole('button', { name: /^Start a review early/ }).click();
  await expect(page.getByTestId('journal-review-scope-section')).toBeVisible();
  await page.getByTestId('journal-review-scope-week').click();

  const title = page.getByRole('textbox', { name: 'Entry title' });
  await expect(title).toHaveValue('Weekly Review — Week 2');
  await page.getByRole('textbox', { name: 'Entry body' }).fill('Halfway through week two.');
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');

  const saved = await page.request.get(`${backendUrl()}/journal/`, { headers });
  const { items } = (await saved.json()) as { items: SavedEntry[] };
  const review = items.find((entry) => entry.reflection_scope_key === 'c1:w2');
  expect(review).toEqual(
    expect.objectContaining({ tag: 'hierarchical_reflection', reflection_level: 'week' }),
  );

  // Back on the shelf, the picker offers to CONTINUE that review rather than
  // start a second one, and pressing it reopens the very page just written.
  await page.getByTestId('journal-close-entry').click();
  await page.getByRole('button', { name: /^Start a review early/ }).click();
  const continueRow = page.getByRole('button', { name: /^Continue — Weekly Review — Week 2/ });
  await expect(continueRow).toBeVisible();
  await continueRow.click();
  await expect(page.getByRole('textbox', { name: 'Entry body' })).toHaveValue(
    'Halfway through week two.',
  );
  await expect(page.getByRole('textbox', { name: 'Entry title' })).toHaveValue(
    'Weekly Review — Week 2',
  );
  const after = await page.request.get(`${backendUrl()}/journal/`, { headers });
  const { items: afterItems } = (await after.json()) as { items: SavedEntry[] };
  expect(afterItems.filter((entry) => entry.reflection_scope_key === 'c1:w2')).toEqual([
    expect.objectContaining({ id: review?.id }),
  ]);
});
