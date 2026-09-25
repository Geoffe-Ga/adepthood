import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * #2930: a journal save that fails is re-sent — by the footer's Retry, or by
 * itself when the device comes back online — and the server ends up holding
 * what the writer sees. The device goes offline for real (`setOffline`), which
 * both fails the writes and drives the NetInfo online/offline events the page
 * listens to; the durable row is read back from the server, not the screen.
 */

const SAVED = 'Saved';
const SAVE_ERROR = "Couldn't save — keep writing, we'll retry";
const RETRY_NAME = 'Retry saving this entry';
const FIRST_BODY = 'A page begun on solid ground.';
const OFFLINE_BODY = 'A page begun on solid ground, then carried through a tunnel.';
const JOURNAL_ENTRY_PATH = /^\/journal\/\d+$/;

interface StoredEntry {
  message: string;
  classification: string;
}

/** The visible page's tier option; a reopened page can leave an earlier screen mounted. */
function tier(page: Page, name: 'public' | 'personal' | 'intimate') {
  return page.locator(`[data-testid="privacy-tier-${name}"]:visible`);
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

async function storedEntry(
  request: APIRequestContext,
  email: string,
  entryId: number,
): Promise<StoredEntry> {
  const response = await request.get(`${backendUrl()}/journal/${entryId}`, {
    headers: bearer(await tokenFor(request, email)),
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as StoredEntry;
}

/** Resolves once `count` PATCHes of this page have come back from the server. */
function patchesLanded(page: Page, count: number): Promise<void> {
  let landed = 0;
  return new Promise((resolve) => {
    page.on('response', (response) => {
      const isPatch = response.request().method() === 'PATCH';
      if (isPatch && JOURNAL_ENTRY_PATH.test(new URL(response.url()).pathname)) landed += 1;
      if (landed === count) resolve();
    });
  });
}

test('writing that failed offline is re-sent on reconnect, with no tap', async ({ page }) => {
  const email = await signUp(page, 'journal-save-retry-reconnect');
  const entryId = await writeSavedPage(page);

  await page.context().setOffline(true);
  await page.getByTestId('journal-body-input').fill(OFFLINE_BODY);
  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVE_ERROR);
  await tier(page, 'intimate').click();
  // The failed PATCH puts the control back on the tier the server still holds.
  await expect(tier(page, 'personal')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: RETRY_NAME })).toBeVisible();

  // Back online: the body, then the (stricter) tier, are re-sent by themselves.
  const resent = patchesLanded(page, 2);
  await page.context().setOffline(false);
  await resent;
  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVED);
  await expect(page.getByRole('button', { name: RETRY_NAME })).toHaveCount(0);
  await expect(tier(page, 'intimate')).toHaveAttribute('aria-checked', 'true');

  expect(await storedEntry(page.request, email, entryId)).toMatchObject({
    message: OFFLINE_BODY,
    classification: 'intimate',
  });

  // Reopened from the shelf, the page shows what the server holds.
  await page.getByTestId('journal-close-entry').click();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await expect(page.locator('[data-testid="journal-body-input"]:visible')).toHaveValue(
    OFFLINE_BODY,
  );
  await expect(tier(page, 'intimate')).toHaveAttribute('aria-checked', 'true');
});

test('the footer Retry re-sends a failed tier change', async ({ page }) => {
  const email = await signUp(page, 'journal-save-retry-tap');
  const entryId = await writeSavedPage(page);

  // Fail exactly one tier PATCH while the device stays online, so only a tap
  // can recover it.
  await page.route(
    (url) => JOURNAL_ENTRY_PATH.test(url.pathname),
    (route) => route.abort('failed'),
    { times: 1 },
  );
  await tier(page, 'intimate').click();
  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVE_ERROR);
  await expect(tier(page, 'personal')).toHaveAttribute('aria-checked', 'true');

  const resent = patchesLanded(page, 1);
  await page.getByRole('button', { name: RETRY_NAME }).click();
  await resent;
  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVED);
  await expect(tier(page, 'intimate')).toHaveAttribute('aria-checked', 'true');
  expect((await storedEntry(page.request, email, entryId)).classification).toBe('intimate');
});

test('a reconnect never makes a page more public than the control shows', async ({ page }) => {
  const email = await signUp(page, 'journal-save-retry-privacy');
  const entryId = await writeSavedPage(page);

  await page.context().setOffline(true);
  await tier(page, 'public').click();
  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVE_ERROR);
  await expect(tier(page, 'personal')).toHaveAttribute('aria-checked', 'true');

  await page.context().setOffline(false);
  // The looser tier is dropped rather than sent: the hint settles truthfully.
  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVED);
  await expect(tier(page, 'personal')).toHaveAttribute('aria-checked', 'true');
  expect((await storedEntry(page.request, email, entryId)).classification).toBe('personal');

  // Choosing Public again, deliberately and online, is what moves it.
  const moved = patchesLanded(page, 1);
  await tier(page, 'public').click();
  await moved;
  expect((await storedEntry(page.request, email, entryId)).classification).toBe('public');
});
