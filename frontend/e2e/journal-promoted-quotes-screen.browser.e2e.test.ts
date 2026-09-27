import { expect, test } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';

/** Enough lines that the promoted passage sits well below the first screenful. */
const FILLER_LINES = 60;
const QUOTE = 'the river kept its own counsel';

test('a writer finds a promoted quote from the drawer, opens it at the passage, and removes it', async ({
  page,
}) => {
  const email = await signUp(page, 'promoted-quotes-screen');
  const headers = bearer(await tokenFor(page.request, email));

  // Seed a long, finished page and promote a passage near its end over the
  // real API, so the screen reads a quote the server itself sliced.
  const filler = Array.from({ length: FILLER_LINES }, (_, i) => `Line ${i + 1} of the walk.`);
  const body = [...filler, `And at the end, ${QUOTE}.`].join('\n');
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: 'Long walk', message: body },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${entryId}`, {
    headers,
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);
  const start = Array.from(body).length - Array.from(`${QUOTE}.`).length;
  const promoted = await page.request.post(`${backendUrl()}/journal/${entryId}/promote`, {
    headers,
    data: { anchor_start: start, anchor_end: start + Array.from(QUOTE).length },
  });
  expect(promoted.ok()).toBe(true);
  const quoteId = ((await promoted.json()) as { id: number }).id;

  // The drawer's door carries no count; the screen's section header does.
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  const listed = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/promotions' &&
      new URL(response.url()).searchParams.get('status') === 'pending',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Promoted quotes' }).click();
  expect((await listed).ok()).toBe(true);
  await expect(page.getByTestId('promoted-quotes-screen')).toBeVisible();
  await expect(page.getByText('Not yet in a review (1)')).toBeVisible();
  await expect(page.getByText('Used in a review (0)')).toBeVisible();
  const row = page.getByTestId(`promoted-quote-${quoteId}`);
  await expect(row).toContainText(QUOTE);
  await expect(row).toContainText('Long walk');

  // Opening the quote opens its page scrolled to the passage, marked.
  await row.click();
  const focused = page.getByTestId(`quote-highlight-${quoteId}-focused`);
  await expect(focused).toHaveText(QUOTE);
  await expect(focused).toBeInViewport();

  // Back on the screen, Remove asks first; the confirmed remove reaches the server.
  await page.goBack();
  await expect(row).toBeVisible();
  await page.getByTestId(`promoted-quote-${quoteId}-remove`).click();
  const removeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === `/promotions/${quoteId}`,
  );
  const [removed] = await Promise.all([
    removeResponse,
    page.getByTestId(`promoted-quote-${quoteId}-confirm-remove`).click(),
  ]);
  expect(removed.ok()).toBe(true);
  await expect(row).toHaveCount(0);

  // A cold reload proves the removal was durable, not just optimistic.
  await page.reload();
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Promoted quotes' }).click();
  await expect(
    page.getByText(
      'Nothing promoted yet. While reading an entry, tap Promote a quote to carry a passage forward.',
    ),
  ).toBeVisible();
  const after = await page.request.get(`${backendUrl()}/promotions`, { headers });
  expect(await after.json()).toEqual({ items: [], total: 0, has_more: false });
});
