/**
 * The deployment-wide vault's owner, on the screen that says where their
 * writing lives (#3608).
 *
 * The lane's vault-bound account is bound by `CREEK_VAULT_OWNER_USER_ID` (the
 * pre-per-user path) and has no connection row of its own, yet every upload and
 * classification of theirs goes to the lane vault. The real server now answers
 * `GET /vault/connection` for them as connected from the deployment source, with
 * no address of any kind, and nothing here is rewritten at the browser: the
 * screen renders from the answer the server actually gave.
 *
 * What it must say is that their writing has a place, and what it must not offer
 * is anything that makes sense only for a vault of the account's own -- a
 * disconnect that would remove no row, or a managed vault set up on top of the
 * one they already have. Nothing of the operator's configuration -- the lane
 * vault's address or its bearer -- is ever in the answer.
 */
import { expect, test, type Response } from '@playwright/test';

import { frontendUrl } from './journalHabitsBrowserSupport';
import { lane, loginVaultOwner } from './seedBrowserSupport';

const CONNECTION_PATH = '/vault/connection';

/** Whether ``response`` answers a read of the account's vault connection. */
function isConnectionRead(response: Response): boolean {
  return response.url().endsWith(CONNECTION_PATH) && response.request().method() === 'GET';
}

test("the deployment vault's owner is told their writing has a place, and offered nothing to undo", async ({
  page,
}) => {
  await loginVaultOwner(page);
  // The hub reads the connection too; its read is let through first, so the one
  // pinned below is the vault screen's own.
  const hubRead = page.waitForResponse(isConnectionRead);
  await page.goto(`${frontendUrl()}/settings`);
  await hubRead;
  const vaultRow = page.getByTestId('settings-row-vault');
  await vaultRow.scrollIntoViewIfNeeded();
  const vaultRead = page.waitForResponse(isConnectionRead);
  await vaultRow.click();
  const connection = await vaultRead;

  expect(connection.status()).toBe(200);
  const raw = await connection.text();
  expect(JSON.parse(raw)).toMatchObject({
    connected: true,
    source: 'deployment',
    vault_url: null,
    mcp_address: null,
  });
  expect(raw).not.toContain(lane().vaultUrl);
  expect(raw).not.toContain(lane().vaultApiKey);

  await expect(page.getByTestId('vault-settings-screen')).toBeVisible();
  await expect(page.getByTestId('vault-deployment-connected')).toBeVisible();
  await expect(page.getByTestId('vault-none-connected')).toHaveCount(0);
  await expect(page.getByTestId('disconnect-vault-button')).toHaveCount(0);
  await expect(page.getByTestId('managed-vault-offer')).toHaveCount(0);
  await expect(page.getByTestId('open-vault-activation')).toHaveCount(0);
});
