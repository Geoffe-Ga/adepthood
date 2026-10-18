import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import {
  backendUrl,
  bearer,
  frontendUrl,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';
import { runBackendModule } from './laneDatabase';

/**
 * #1938 B21: the paid membership gate and the AI wallet must never become a
 * paywall around the journal floor.
 *
 * The lane's one external substitution is still Gumroad verification. Its
 * deterministic purchase explicitly carries `price: 0`; this spec therefore
 * proves what Adepthood does after a zero-price verification answer, not that
 * Gumroad would return that answer in production. The browser signs up through
 * the real screen, then a database arrange moves that one account to the real
 * deployment's served monthly cap with an empty offering balance. Core work
 * continues through production screens, clients, routes and Postgres.
 *
 * Both export buttons, page deletion and final account deletion remain
 * available. The wallet ledger brackets the journey so those core actions
 * cannot quietly become charges. Revocation is a separate journey because one
 * covering spec may own only one ledger entry.
 */

interface Wallet {
  monthly_messages_used: number;
  offering_balance: number;
  rows: unknown[];
}

interface ExhaustedAllowance extends Wallet {
  monthly_cap: number;
}

const TITLE = 'The floor stays mine';
const FIRST_BODY = 'A quiet page written with no AI allowance left.';
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const ALLOWANCE_MODULE = 'tests.e2e.exhaust_allowance';

function visible(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`);
}

function wallet(email: string): Wallet {
  return JSON.parse(
    runBackendModule('tests.e2e.wallet_audit', ['show', '--email', email]),
  ) as Wallet;
}

function exhaustAllowance(email: string): ExhaustedAllowance {
  return JSON.parse(
    runBackendModule(ALLOWANCE_MODULE, ['exhaust', '--email', email]),
  ) as ExhaustedAllowance;
}

function expectWalletState(actual: Wallet, expected: ExhaustedAllowance): void {
  expect(actual.monthly_messages_used).toBe(expected.monthly_messages_used);
  expect(actual.offering_balance).toBe(expected.offering_balance);
  expect(actual.rows).toEqual(expected.rows);
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

test('a zero-price member keeps the journal floor when the AI wallet is exhausted', async ({
  page,
}) => {
  const email = await signUp(page, 'zero-payment-core');
  const { token } = await sessionFor(page.request, email);
  const headers = bearer(token);
  const exhausted = exhaustAllowance(email);
  expect(exhausted.monthly_cap).toBeGreaterThan(0);
  expect(exhausted.monthly_messages_used).toBe(exhausted.monthly_cap);
  expect(exhausted.offering_balance).toBe(0);
  expect(exhausted.rows).toEqual([]);

  await page.goto(`${frontendUrl()}/journal`);
  await visible(page, 'journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill(TITLE);
  await page.getByTestId('journal-body-input').fill(FIRST_BODY);
  const entryId = ((await (await created).json()) as { id: number }).id;
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
  const finished = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === `/journal/${entryId}`,
  );
  await page.getByTestId('journal-finish-button').click();
  expect((await finished).status()).toBe(HTTP_OK);

  await page.goto(`${frontendUrl()}/settings`);
  await page.getByTestId('settings-row-export-data').click();
  expect(await exportThroughScreen(page, 'export-data-json')).toContain(FIRST_BODY);
  expect(await exportThroughScreen(page, 'export-data-markdown')).toContain(FIRST_BODY);
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
  expectWalletState(wallet(email), exhausted);

  await page.goto(`${frontendUrl()}/settings`);
  await page.getByTestId('settings-row-delete-account').click();
  await page.getByTestId('delete-account-email-input').fill(email);
  await page.getByTestId('delete-account-submit').click();
  await expect(page.getByTestId('delete-account-receipt')).toBeVisible();

  const gone = await page.request.get(`${backendUrl()}/journal/`, { headers });
  expect(gone.status()).toBe(401);
});
