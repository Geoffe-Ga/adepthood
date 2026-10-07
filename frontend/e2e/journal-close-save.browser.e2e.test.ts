import { expect, test, type Request } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

function isShelfRead(request: Request): boolean {
  return request.method() === 'GET' && new URL(request.url()).pathname === '/journal/';
}

test('closing a fresh page saves before the shelf reloads it', async ({ page }) => {
  await signUp(page, 'journal-close-save');
  const title = 'A page kept by the close button';
  const body = 'The shelf must not outrun this first save.';
  await page.getByTestId('journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  // Only a shelf read the close itself starts counts as the reload. `signUp`
  // returns once the journal menu shows, so the shelf's own first read can
  // still be in flight here; letting it answer would race the test, not the app.
  let closing = false;
  const closeReads = new Set<Request>();
  page.on('request', (request) => {
    if (closing && isShelfRead(request)) closeReads.add(request);
  });
  const shelfReloaded = page.waitForResponse((response) => closeReads.has(response.request()));
  const firstSettled = Promise.race([
    created.then(() => 'create' as const),
    shelfReloaded.then(() => 'shelf' as const),
  ]);
  await page.getByTestId('journal-title-input').fill(title);
  await page.getByTestId('journal-body-input').fill(body);
  closing = true;
  await page.getByTestId('journal-close-entry').click();

  expect(await firstSettled).toBe('create');
  const entryId = ((await (await created).json()) as { id: number }).id;
  expect((await shelfReloaded).ok()).toBe(true);
  const savedPage = page.getByTestId(`journal-shelf-open-${entryId}`);
  await expect(savedPage).toContainText(title);

  await savedPage.click();
  await expect(page.locator('[data-testid="journal-body-input"]:visible')).toHaveValue(body);
});
