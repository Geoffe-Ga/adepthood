import { expect, test } from '@playwright/test';

import { frontendUrl, signUp } from './journalHabitsBrowserSupport';

/**
 * The dashboard's door in the Journal drawer (#3794).
 *
 * Until this door the dashboard was reached only through Settings or a
 * finished Seed run. The drawer row is shown to every account and asks
 * nothing first, so the account driving it here is a fresh one with no vault:
 * the row must still be there, sit directly under Corpus upload, and land on
 * the dashboard, whose own answer to the live `GET /vault/pipeline` says that
 * nothing is connected. The row's label is read from the screen it opens
 * rather than spelled here, because both come from one constant.
 */

const HTTP_OK = 200;

function isPipelineRead(url: string, method: string): boolean {
  return new URL(url).pathname === '/vault/pipeline' && method === 'GET';
}

test('the Journal drawer opens the dashboard, from the shelf and from an open entry', async ({
  page,
}) => {
  await signUp(page, 'journal-vault-dashboard-door');

  // From the shelf: the row sits directly under Corpus upload, with an icon.
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  const drawer = page.getByRole('dialog');
  const door = drawer.getByTestId('journal-drawer-vault-dashboard');
  await expect(door.locator('svg')).toHaveCount(1);
  const doors = await drawer
    .locator('[data-testid^="journal-drawer-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
  expect(doors.indexOf('journal-drawer-vault-dashboard')).toBe(
    doors.indexOf('journal-drawer-corpus') + 1,
  );
  const label = (await door.innerText()).trim();

  const pipelineRead = page.waitForResponse((response) =>
    isPipelineRead(response.url(), response.request().method()),
  );
  await door.click();
  await expect(page.getByTestId('vault-dashboard-screen')).toBeVisible();
  await expect(page.getByTestId('screen-drawer')).toHaveCount(0);
  const answer = await pipelineRead;
  expect(answer.status()).toBe(HTTP_OK);
  expect(((await answer.json()) as { vault_status: string }).vault_status).toBe('not_connected');
  await expect(page.getByTestId('vault-dashboard-not-connected')).toBeVisible();
  // The door and the screen it opens share one name: exactly one heading says
  // exactly what the row said, and it is the stack header's, above the body.
  // A substring match would be satisfied by a section heading that merely
  // contains the words.
  const title = page.getByRole('heading', { name: label, exact: true });
  await expect(title).toHaveCount(1);
  await expect(title).toBeVisible();
  await expect(
    page.getByTestId('vault-dashboard-screen').getByRole('heading', { name: label, exact: true }),
  ).toHaveCount(0);

  // From an open entry: the same row, the same place.
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId('journal-new-entry').click();
  await expect(page.getByTestId('journal-close-entry')).toBeVisible();
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByTestId('journal-drawer-vault-dashboard').click();
  await expect(page.getByTestId('vault-dashboard-not-connected')).toBeVisible();
  await expect(page.getByTestId('screen-drawer')).toHaveCount(0);
});
