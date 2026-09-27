import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * #2935: a saved page opened from the shelf while the device is offline cannot
 * load (the client short-circuits the GET), so the page shows its load-error
 * banner and will not save. When the device comes back online the load runs
 * again by itself: the banner clears, the stored page appears, and writing on
 * it saves, all without reopening it. The device goes offline for real
 * (`setOffline`), which drives the window offline/online events the app bridges
 * into its connectivity signal; the stored row is read back from the server.
 */

const SAVED = 'Saved';
const FIRST_BODY = 'A page kept safe before the signal dropped.';
const NEXT_BODY = 'A page kept safe before the signal dropped, and picked up again.';
const JOURNAL_ENTRY_PATH = /^\/journal\/\d+$/;

/** The visible copy of a test id; a reopened page can leave an earlier screen mounted. */
function visible(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`);
}

/** Open a fresh page, write it, and wait for its first create to land. */
async function writeSavedPage(page: Page): Promise<number> {
  await page.getByTestId('journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-body-input').fill(FIRST_BODY);
  const entryId = ((await (await created).json()) as { id: number }).id;
  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVED);
  return entryId;
}

/** Take the device offline and wait until the app itself says so. */
async function goOffline(page: Page): Promise<void> {
  await page.context().setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
}

/** Bring the device back online and wait until the app has registered it. */
async function goOnline(page: Page): Promise<void> {
  await page.context().setOffline(false);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
}

async function storedBody(
  request: APIRequestContext,
  email: string,
  entryId: number,
): Promise<string> {
  const response = await request.get(`${backendUrl()}/journal/${entryId}`, {
    headers: bearer(await tokenFor(request, email)),
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { message: string }).message;
}

test('a page opened offline loads by itself on reconnect and saves again', async ({ page }) => {
  const email = await signUp(page, 'journal-reconnect-load');
  const entryId = await writeSavedPage(page);
  await page.getByTestId('journal-close-entry').click();
  const shelfRow = page.getByTestId(`journal-shelf-open-${entryId}`);
  await expect(shelfRow).toBeVisible();

  await goOffline(page);
  await shelfRow.click();
  await expect(visible(page, 'journal-load-error')).toBeVisible();

  await goOnline(page);
  await expect(visible(page, 'journal-load-error')).toHaveCount(0);
  const body = visible(page, 'journal-body-input');
  await expect(body).toHaveValue(FIRST_BODY);

  // Without reopening the page, writing on it saves again.
  const patched = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      JOURNAL_ENTRY_PATH.test(new URL(response.url()).pathname),
  );
  await body.fill(NEXT_BODY);
  expect((await patched).ok()).toBe(true);
  await expect(visible(page, 'journal-save-hint')).toHaveText(SAVED);

  expect(await storedBody(page.request, email, entryId)).toBe(NEXT_BODY);
});
