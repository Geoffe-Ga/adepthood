import { expect, test } from '@playwright/test';

import {
  backendUrl,
  setProgramAnchorSixDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

test('a saved promoted quote can be folded into a reopened reflection', async ({ page }) => {
  const email = await signUp(page, 'promote-fold-real-wire');
  const token = await tokenFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  setProgramAnchorSixDaysAgo(email);
  const sourceBody = 'I walked beside the river before breakfast.';
  const source = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: 'Morning walk', message: sourceBody },
  });
  const sourceId = ((await source.json()) as { id: number }).id;
  await page.request.patch(`${backendUrl()}/journal/${sourceId}`, {
    headers,
    data: { status: 'finished' },
  });
  const promoted = await page.request.post(`${backendUrl()}/journal/${sourceId}/promote`, {
    headers,
    data: { anchor_start: 0, anchor_end: 8 },
  });
  expect(promoted.ok()).toBe(true);
  const quoteId = ((await promoted.json()) as { id: number }).id;

  await page.reload();
  await page.getByTestId('journal-reflection-band').click();
  await page.getByRole('textbox', { name: 'Entry body' }).fill('Looking back on the week.');
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
  const savedJournal = await page.request.get(`${backendUrl()}/journal/`, { headers });
  const savedEntries = (await savedJournal.json()) as {
    items: Array<{ id: number; tag: string; reflection_scope_key: string | null }>;
  };
  const savedReflection = savedEntries.items.find(
    (entry) => entry.reflection_scope_key === 'c1:w1',
  );
  expect(savedReflection).toEqual(expect.objectContaining({ tag: 'hierarchical_reflection' }));

  await page.getByTestId('journal-close-entry').click();
  await page.getByTestId(`journal-shelf-open-${savedReflection?.id}`).click();
  await page.locator('[data-testid="reflection-sources-toggle"]:visible').click();
  const pendingQuote = page.locator(`[data-testid="pending-quote-${quoteId}"]:visible`);
  await expect(pendingQuote).toContainText('I walked');
  await pendingQuote.click();

  await expect(page.getByRole('textbox', { name: 'Entry body' }).last()).toHaveValue(/> I walked/u);
  await expect(page.locator('[data-testid="journal-save-hint"]:visible')).toHaveText('Saved');
  const folded = await page.request.get(`${backendUrl()}/journal/${sourceId}/promotions`, {
    headers,
  });
  expect((await folded.json()) as Array<{ pending: boolean }>).toEqual([
    expect.objectContaining({ pending: false }),
  ]);
});
