import { expect, test } from '@playwright/test';

import { backendUrl, seedHabit, signUp, tokenFor } from './journalHabitsBrowserSupport';

const ACCEPT_ROUTE = '**/journal/suggestions/*/accept';

test('a refused check-off says so beside the card, which stays pressable', async ({ page }) => {
  const email = await signUp(page, 'failed-checkoff');
  const token = await tokenFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  await seedHabit(page.request, token, 'Evening swim');
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: 'A small note', message: 'I completed Evening swim.' },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${entryId}`, {
    headers,
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);

  // Refusing only the literary pass is how this lane reaches a suggestion card
  // without an LLM; detection, the row, and the accept stay real-wire.
  await page.route(`**/journal/${entryId}/resonance`, async (route) => {
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'llm_provider_error' }),
    });
  });
  // The refusal under test. A 500 stands in for the whole class the margin used
  // to swallow -- a 401, a 404, a 409 on an already-dismissed row, a request
  // that never arrives -- because every one of them reaches the same catch.
  await page.route(ACCEPT_ROUTE, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'boom' }),
    });
  });
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await page.getByRole('button', { name: 'Get resonance' }).click();

  const checkOff = page.getByRole('button', {
    name: 'Check off completed Evening swim',
    exact: true,
  });
  await expect(checkOff).toBeVisible();
  await checkOff.click();

  // The whole point: the refusal is legible, and it is legible *here*, with the
  // card that produced it still on the page rather than in place of it.
  const marginError = page.getByTestId('journal-resonance-error');
  await expect(marginError).toContainText("That check-off didn't go through");
  await expect(marginError).toContainText('the card is still here');
  await expect(checkOff).toBeVisible();
  await expect(page.getByText(/Checked off/u)).toHaveCount(0);

  // Still pressable, and the server still has the row pending to accept.
  await page.unroute(ACCEPT_ROUTE);
  await checkOff.click();

  await expect(page.getByText(/Checked off/u)).toBeVisible();
  await expect(marginError).toHaveCount(0);

  const suggestions = await page.request.get(`${backendUrl()}/journal/${entryId}/suggestions`, {
    headers,
  });
  expect(suggestions.ok()).toBe(true);
  expect((await suggestions.json()) as { items: Array<{ status: string }> }).toEqual({
    items: [expect.objectContaining({ status: 'accepted' })],
  });
});
