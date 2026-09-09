import { expect, test } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

test('a reader can promote a selected quote, reload it, and remove it over the real wire', async ({
  page,
}) => {
  const email = await signUp(page, 'promote-real-wire');
  const token = await tokenFor(page.request, email);
  const body = 'I walked beside the river and noticed the light on the water.';
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'River light', message: body },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${entryId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);

  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await page.getByTestId('promote-quote-button').click();

  const selection = page.locator('textarea[data-testid="quote-select-input"]');
  const box = await selection.boundingBox();
  if (box === null) throw new Error('the quote-selection field has no layout box');
  await page.mouse.move(box.x + 8, box.y + 24);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + 24, { steps: 8 });
  await page.mouse.up();
  const preview = page.getByTestId('quote-select-preview');
  await expect(preview).toContainText(/\S/u);
  const selectedText = (await preview.textContent())?.trim();
  if (!selectedText) throw new Error('mouse selection produced no promoted text');
  await page.getByTestId('quote-select-confirm').click();

  await expect(page.getByTestId('quote-promotion-success')).toHaveText('Promoted');
  const promotions = await page.request.get(`${backendUrl()}/journal/${entryId}/promotions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(promotions.ok()).toBe(true);
  const [quote] = (await promotions.json()) as Array<{ id: number; anchor_text: string }>;
  expect(quote?.anchor_text).toBe(selectedText);

  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await expect(page.getByTestId(`quote-highlight-${quote?.id}`)).toHaveText(selectedText);
  await page.getByTestId(`quote-highlight-${quote?.id}`).click();
  await page.getByTestId(`promotion-remove-${quote?.id}`).click();
  await expect(page.getByTestId(`quote-highlight-${quote?.id}`)).toHaveCount(0);

  const afterRemove = await page.request.get(`${backendUrl()}/journal/${entryId}/promotions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(await afterRemove.json()).toEqual([]);
});
