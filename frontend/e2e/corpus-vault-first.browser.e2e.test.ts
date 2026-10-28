import { expect, test } from '@playwright/test';

import { frontendUrl, signUp } from './journalHabitsBrowserSupport';

/**
 * "Bring in your writing" waits for a place to keep what comes in (#3017).
 *
 * A corpus lives in a vault (owner ruling on #3015), and since #3016 the server
 * keeps nothing a vault-less account sends. So the hub's seed row, for an
 * account the server says has nothing attached, says where that place is set up
 * and opens it rather than a picker. Driven unstubbed: a fresh account on this
 * lane has no vault of its own and is not the deployment binding's owner, so
 * the live `GET /vault/connection` answers `connected: false`.
 */
test('an account with no vault is shown where its corpus lives before the picker', async ({
  page,
}) => {
  await signUp(page, 'corpus-vault-first');

  const vaultRead = page.waitForResponse(
    (response) =>
      response.url().endsWith('/vault/connection') && response.request().method() === 'GET',
  );
  await page.goto(`${frontendUrl()}/settings`);
  await vaultRead;

  const corpusRows = page.getByTestId('settings-group-corpus').getByTestId(/^settings-row-/u);
  await expect(corpusRows.first()).toHaveAttribute('data-testid', 'settings-row-vault');

  const seedRow = page.getByTestId('settings-row-seed-corpus');
  await expect(seedRow).toContainText('Bring in your writing');
  await expect(seedRow).toContainText('Where your writing lives');

  await seedRow.click();

  await expect(page.getByTestId('vault-settings-screen')).toBeVisible();
  await expect(page.getByTestId('seed-corpus-screen')).toHaveCount(0);
});
