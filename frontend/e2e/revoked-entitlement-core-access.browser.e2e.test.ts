import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';

import {
  ACCOUNT_PHRASE,
  backendUrl,
  bearer,
  frontendUrl,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';
import { runBackendModule } from './laneDatabase';
import { freshLicenseKey } from './licenseKey';

/**
 * #1938 B21 E1: an operator revocation is an AI admission gate, not a gate
 * around the writer's own data. The admin mutation is arrangement through the
 * production route; the product evidence starts at the real finished-entry
 * screen, crosses the production client and journal route, and renders the
 * server's 403 before the same session edits, exports and deletes normally.
 */

interface Wallet {
  monthly_messages_used: number;
  offering_balance: number;
  rows: unknown[];
}

interface Usage {
  monthly_messages_remaining: number;
}

const FIRST_BODY = 'A saved page remains mine after access changes.';
const EDITED_BODY = `${FIRST_BODY} I can still revise it.`;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_FORBIDDEN = 403;
const PROMOTE_MODULE = 'tests.e2e.promote_admin';

function visible(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`);
}

function isFinishedPatch(response: Response, entryId: number): boolean {
  const request = response.request();
  if (request.method() !== 'PATCH' || new URL(response.url()).pathname !== `/journal/${entryId}`) {
    return false;
  }
  const payload = request.postDataJSON() as unknown;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'status' in payload &&
    payload.status === 'finished'
  );
}

function wallet(email: string): Wallet {
  return JSON.parse(
    runBackendModule('tests.e2e.wallet_audit', ['show', '--email', email]),
  ) as Wallet;
}

async function userId(request: APIRequestContext, email: string): Promise<number> {
  const login = await request.post(`${backendUrl()}/auth/login`, {
    data: { email, password: ACCOUNT_PHRASE },
  });
  expect(login.status()).toBe(HTTP_OK);
  return ((await login.json()) as { user_id: number }).user_id;
}

async function revokeThroughAdmin(page: Page, targetUserId: number): Promise<void> {
  const operatorEmail = `revocation-operator-${randomBytes(6).toString('hex')}@example.com`;
  const signup = await page.request.post(`${backendUrl()}/auth/signup`, {
    data: {
      email: operatorEmail,
      password: ACCOUNT_PHRASE,
      timezone: 'UTC',
      license_key: freshLicenseKey(),
    },
  });
  expect(signup.status()).toBe(HTTP_OK);
  const operatorToken = ((await signup.json()) as { token: string }).token;
  const promoted = JSON.parse(
    runBackendModule(PROMOTE_MODULE, ['promote', '--email', operatorEmail]),
  ) as { is_admin: boolean };
  expect(promoted.is_admin).toBe(true);

  const summary = await page.request.get(`${backendUrl()}/admin/users/${targetUserId}/summary`, {
    headers: bearer(operatorToken),
  });
  expect(summary.status()).toBe(HTTP_OK);
  const active = (
    (await summary.json()) as {
      entitlements: Array<{ id: number; revoked_at: string | null }>;
    }
  ).entitlements.find((entitlement) => entitlement.revoked_at === null);
  expect(active).toBeDefined();
  const revoked = await page.request.delete(
    `${backendUrl()}/admin/users/${targetUserId}/entitlements/${active!.id}`,
    {
      headers: bearer(operatorToken),
      data: { reason: 'Browser proof that revocation limits AI only (#1938).' },
    },
  );
  expect(revoked.status()).toBe(HTTP_OK);
  expect((await revoked.json()).revoked_at).not.toBeNull();
}

async function exportThroughScreen(page: Page, testId: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(testId).click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error(`${testId} produced no readable browser download`);
  await expect(page.getByTestId('export-data-receipt')).toBeVisible();
  return readFileSync(path, 'utf8');
}

test('a revoked entitlement refuses AI but leaves writing, export and deletion intact', async ({
  page,
}) => {
  const email = await signUp(page, 'revoked-core');
  const { token } = await sessionFor(page.request, email);
  const headers = bearer(token);
  const targetUserId = await userId(page.request, email);

  await page.goto(`${frontendUrl()}/journal`);
  await visible(page, 'journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-body-input').fill(FIRST_BODY);
  const entryId = ((await (await created).json()) as { id: number }).id;
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
  const finished = page.waitForResponse((response) => isFinishedPatch(response, entryId));
  await page.getByTestId('journal-finish-button').click();
  expect((await finished).status()).toBe(HTTP_OK);
  await expect(page.getByTestId('journal-edit-button')).toBeVisible();
  const usageResponse = await page.request.get(`${backendUrl()}/user/usage`, { headers });
  expect(usageResponse.status()).toBe(HTTP_OK);
  const usage = (await usageResponse.json()) as Usage;
  expect(usage.monthly_messages_remaining).toBeGreaterThan(0);
  const before = wallet(email);

  await revokeThroughAdmin(page, targetUserId);
  await page.goto(`${frontendUrl()}/journal`);
  await visible(page, `journal-shelf-open-${entryId}`).click();
  await page.getByRole('button', { name: 'Get resonance' }).click();
  const refusal = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/journal/${entryId}/resonance`,
  );
  await page.getByTestId('resonance-explainer-continue').click();
  expect((await refusal).status()).toBe(HTTP_FORBIDDEN);
  const error = page.getByTestId('journal-resonance-error');
  await expect(error).toContainText('APTITUDE membership is no longer active');
  await expect(error).toContainText('Nothing was charged');
  await expect(error).toContainText('export or delete your data whenever you like');

  await page.getByTestId('journal-edit-button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Edit this entry' }).click();
  await page.getByTestId('journal-body-input').fill(EDITED_BODY);
  const refinished = page.waitForResponse((response) => isFinishedPatch(response, entryId));
  await page.getByTestId('journal-finish-button').click();
  expect((await refinished).status()).toBe(HTTP_OK);
  await expect(page.getByTestId('journal-edit-button')).toBeVisible();
  const stored = await page.request.get(`${backendUrl()}/journal/${entryId}`, { headers });
  expect((await stored.json()).message).toBe(EDITED_BODY);

  await page.goto(`${frontendUrl()}/settings`);
  await page.getByTestId('settings-row-export-data').click();
  expect(await exportThroughScreen(page, 'export-data-json')).toContain(EDITED_BODY);
  expect(await exportThroughScreen(page, 'export-data-markdown')).toContain(EDITED_BODY);

  await page.goto(`${frontendUrl()}/journal`);
  await visible(page, `journal-shelf-delete-${entryId}`).click();
  const deleted = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === `/journal/${entryId}`,
  );
  await visible(page, 'journal-delete-confirm').click();
  expect((await deleted).status()).toBe(HTTP_NO_CONTENT);
  await expect(visible(page, `journal-shelf-open-${entryId}`)).toHaveCount(0);
  expect(wallet(email)).toEqual(before);

  await page.goto(`${frontendUrl()}/settings`);
  await page.getByTestId('settings-row-delete-account').click();
  await page.getByTestId('delete-account-email-input').fill(email);
  await page.getByTestId('delete-account-submit').click();
  await expect(page.getByTestId('delete-account-receipt')).toBeVisible();
  const gone = await page.request.get(`${backendUrl()}/journal/`, { headers });
  expect(gone.status()).toBe(401);
});
