import { expect, test, type Page } from '@playwright/test';

import { backendUrl, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';
import { readLaneState } from './laneState';

const DRAFT_TITLE = 'The page beneath settings';
const DRAFT_BODY =
  'The river is carrying a thought I want to keep while I step away to change how resonance is paid for.';

interface UsageOverrides {
  monthly_messages_remaining: number;
  offering_balance: number;
}

/** Make the browser's wallet read deterministic without changing the production request path. */
async function serveUsage(page: Page, overrides: UsageOverrides): Promise<void> {
  await page.route('**/user/usage', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        monthly_messages_used: 50 - overrides.monthly_messages_remaining,
        monthly_messages_remaining: overrides.monthly_messages_remaining,
        monthly_cap: 50,
        monthly_reset_date: '2026-10-01T00:00:00Z',
        offering_balance: overrides.offering_balance,
      }),
    });
  });
}

/** Hold one wallet response while the writer changes payer on the mounted entry. */
async function holdUsage(page: Page): Promise<{
  requested: Promise<void>;
  release: () => void;
}> {
  let markRequested = (): void => undefined;
  let release = (): void => undefined;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/user/usage', async (route) => {
    markRequested();
    await held;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        monthly_messages_used: 0,
        monthly_messages_remaining: 0,
        monthly_cap: 0,
        monthly_reset_date: '2026-10-01T00:00:00Z',
        offering_balance: 0,
      }),
    });
  });
  return { requested, release };
}

/** Hold the accepted pass so Settings can invalidate its later funding surface. */
async function holdFundingFailure(page: Page): Promise<{
  requested: Promise<void>;
  release: () => void;
}> {
  let markRequested = (): void => undefined;
  let release = (): void => undefined;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/journal/*/resonance', async (route) => {
    markRequested();
    await held;
    await route.fulfill({
      status: 402,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'llm_key_required' }),
    });
  });
  return { requested, release };
}

async function expectDraft(page: Page): Promise<void> {
  await expect(page.getByTestId('journal-title-input')).toHaveValue(DRAFT_TITLE);
  await expect(page.getByTestId('journal-body-input')).toHaveValue(DRAFT_BODY);
}

test('an empty wallet offers API-key settings and returns to the same journal draft', async ({
  page,
}) => {
  await signUp(page, 'journal-resonance-refill');
  await serveUsage(page, { monthly_messages_remaining: 0, offering_balance: 0 });
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-title-input').fill(DRAFT_TITLE);
  await page.getByTestId('journal-body-input').fill(DRAFT_BODY);

  // The exit-row shortcut is available before a pass and push/pop keeps this
  // exact editor instance alive beneath Settings.
  await page.getByRole('button', { name: 'Add or change your API key' }).click();
  await expect(page.getByTestId('api-key-settings-screen')).toBeVisible();
  await page.getByRole('link', { name: 'Go back' }).click();
  await expectDraft(page);

  await expect(page.getByRole('button', { name: 'Get resonance' })).toBeEnabled();
  await page.getByRole('button', { name: 'Get resonance' }).click();
  const refill = page.getByTestId('journal-resonance-refill');
  await expect(refill).toBeVisible();
  await expect(refill).toContainText('October 1, 2026');
  await expect(page.getByTestId('resonance-explainer')).toHaveCount(0);
  await expect(refill.getByText(/Don.t show this again/u)).toHaveCount(0);

  await page.getByRole('button', { name: 'Add your API key', exact: true }).click();
  await expect(page.getByTestId('api-key-settings-screen')).toBeVisible();
  await page.getByRole('link', { name: 'Go back' }).click();
  await expectDraft(page);
});

test('a stale wallet read that receives a 402 replaces the spend dialog with refill', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-resonance-stale-wallet');
  const token = await tokenFor(page.request, email);
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: DRAFT_TITLE, message: DRAFT_BODY },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  await serveUsage(page, { monthly_messages_remaining: 4, offering_balance: 0 });

  let passCount = 0;
  await page.route(`**/journal/${String(entryId)}/resonance`, async (route) => {
    passCount += 1;
    await route.fulfill({
      status: 402,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'insufficient_offerings' }),
    });
  });
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect(page.getByTestId('resonance-explainer')).toBeVisible();
  await page.getByTestId('resonance-explainer-dont-show').click();
  await page.getByTestId('resonance-explainer-continue').click();

  await expect(page.getByTestId('journal-resonance-refill')).toBeVisible();
  await expect(page.getByTestId('resonance-explainer')).toHaveCount(0);
  expect(passCount).toBe(1);
});

test('saving a key while wallet preflight is held cannot publish the obsolete no-key result', async ({
  page,
}) => {
  const key = readLaneState()?.spentOpenaiKey;
  if (!key) throw new Error('the browser lane did not provide its BYOK fixture');
  await signUp(page, 'journal-resonance-refill-payer-change');
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-title-input').fill(DRAFT_TITLE);
  await page.getByTestId('journal-body-input').fill(DRAFT_BODY);
  const usage = await holdUsage(page);

  await page.getByRole('button', { name: 'Get resonance' }).click();
  await usage.requested;
  await expect(
    page.getByRole('button', { name: 'Checking resonance availability' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Add or change your API key' }).click();
  await page.getByTestId('api-key-input').fill(key);
  await page.getByTestId('save-key-button').click();
  await expect(page.getByTestId('stored-key-card')).toBeVisible();
  usage.release();
  await page.getByRole('link', { name: 'Go back' }).click();

  await expectDraft(page);
  await expect(page.getByTestId('resonance-explainer')).toHaveCount(0);
  await expect(page.getByTestId('journal-resonance-refill')).toHaveCount(0);
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect(page.getByTestId('resonance-explainer-cost')).toContainText(
    'Your own API key pays for this reading',
  );
});

test('a held accepted pass cannot portal a stale funding invitation over API-key settings', async ({
  page,
}) => {
  const key = readLaneState()?.spentOpenaiKey;
  if (!key) throw new Error('the browser lane did not provide its BYOK fixture');
  await signUp(page, 'journal-resonance-refill-held-pass');
  await serveUsage(page, { monthly_messages_remaining: 4, offering_balance: 0 });
  const pass = await holdFundingFailure(page);
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-title-input').fill(DRAFT_TITLE);
  await page.getByTestId('journal-body-input').fill(DRAFT_BODY);

  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect(page.getByTestId('resonance-explainer')).toBeVisible();
  await page.getByTestId('resonance-explainer-continue').click();
  await pass.requested;
  await page.getByRole('button', { name: 'Add or change your API key' }).click();
  await page.getByTestId('api-key-input').fill(key);
  await page.getByTestId('save-key-button').click();
  await expect(page.getByTestId('stored-key-card')).toBeVisible();

  pass.release();
  await page.getByRole('link', { name: 'Go back' }).click();
  await expect(page.getByRole('button', { name: 'Get resonance' })).toBeEnabled();
  await expectDraft(page);
  await expect(page.getByTestId('journal-resonance-refill')).toHaveCount(0);
});
