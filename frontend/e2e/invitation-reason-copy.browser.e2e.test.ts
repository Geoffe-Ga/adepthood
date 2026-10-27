import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { expectTextWithinViewport, seedInvitations } from './declineOwnershipBrowserSupport';
import { backendUrl, bearer, frontendUrl } from './journalHabitsBrowserSupport';
import { readLaneState } from './laneState';

const QUOTE = 'tension in my shoulders';
const REASON = 'You describe tension as a bodily sensation in your journal.';
const BENEFIT = 'This reading offers a way to explore attention to physical sensations.';
const ARTIFACTS = join(__dirname, 'artifacts', 'grounded-reading-invitation');

function lane() {
  const state = readLaneState();
  if (!state) throw new Error('Missing isolated vault lane');
  return state;
}

async function advertise(page: Page, enabled: boolean): Promise<void> {
  const response = await page.request.post(
    `${lane().vaultUrl}/__lane/${enabled ? 'advertise' : 'withdraw'}-readings`,
    {
      headers: bearer(lane().vaultApiKey),
    },
  );
  expect(response.status()).toBe(200);
}

async function loginOwner(page: Page): Promise<string> {
  const state = lane();
  const login = await page.request.post(`${backendUrl()}/auth/login`, {
    data: { email: state.vaultOwnerEmail, password: state.vaultOwnerPassword },
  });
  expect(login.status()).toBe(200);
  const { token } = (await login.json()) as { token: string };
  await page.request.patch(`${backendUrl()}/ui-flags`, {
    headers: bearer(token),
    data: { has_seen_welcome: true },
  });
  await page.goto(`${frontendUrl()}/login`);
  await page.getByRole('textbox', { name: 'Email' }).fill(state.vaultOwnerEmail);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(state.vaultOwnerPassword);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  return token;
}

test.afterEach(async ({ page }) => {
  await advertise(page, false);
});

test('a vault-grounded invitation cites the source, explains the benefit, and directly opens its chapter', async ({
  page,
}) => {
  // Three viewport round trips plus warm/source/reload checks share this journey budget.
  test.setTimeout(120_000);
  await advertise(page, true);
  const token = await loginOwner(page);
  const headers = bearer(token);
  const consent = await page.request.put(`${backendUrl()}/corpus/consent/journal`, {
    headers,
    data: { granted: true },
  });
  expect(consent.status()).toBe(200);
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: {
      title: 'A synthetic walk',
      message: `I noticed ${QUOTE} while walking.`,
      classification: 'personal',
    },
  });
  expect(created.status()).toBe(201);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers,
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(200);
  const [id] = seedInvitations(lane().vaultOwnerEmail, [
    { targetType: 'course', targetId: 1, kind: 'readiness' },
  ]);
  if (id === undefined) throw new Error('Missing invitation seed');
  const listed = await page.request.get(`${backendUrl()}/invitations`, { headers });
  expect(listed.status()).toBe(200);
  const invitations = (await listed.json()) as {
    id: number;
    reading: { content_id: number; title: string; entry_id: number };
  }[];
  const suggestion = invitations.find((item) => item.id === id)?.reading;
  expect(suggestion?.entry_id).toBe(entryId);
  if (!suggestion) throw new Error('Managed-vault recommendation did not cross the wire');
  mkdirSync(ARTIFACTS, { recursive: true });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(frontendUrl());
    await page.getByTestId('journal-notifications-open').click();
    const card = page.getByTestId(`invitation-${String(id)}`);
    await expect(card).toContainText(QUOTE);
    await expect(card).toContainText(REASON);
    await expect(card).toContainText(BENEFIT);
    await expect(card).toContainText(suggestion.title);
    await expectTextWithinViewport(page, `invitation-${String(id)}`);
    await page.screenshot({ path: join(ARTIFACTS, `${String(viewport.width)}.png`) });
    const body = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/course/content/${String(suggestion.content_id)}/body`,
    );
    await page.getByTestId(`invitation-${String(id)}-open`).focus();
    await page.keyboard.press('Enter');
    expect((await body).ok()).toBe(true);
    await expect(page.getByTestId('reader-markdown')).toBeVisible();
  }
  // Keep Course and its reader mounted, return through the drawer, then reopen the same chapter.
  await page.getByRole('button', { name: 'Open Course menu', exact: true }).click();
  await page.getByTestId('drawer-nav-Prompts').click();
  const warmBody = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `/course/content/${String(suggestion.content_id)}/body`,
  );
  await page.getByTestId(`invitation-${String(id)}-open`).click();
  expect((await warmBody).ok()).toBe(true);
  await expect(page.getByTestId('reader-markdown')).toBeVisible();
  await page.getByRole('button', { name: 'Open Course menu', exact: true }).click();
  await page.getByTestId('drawer-nav-Prompts').click();
  const source = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/journal/${String(entryId)}`,
  );
  await page.getByTestId(`invitation-${String(id)}-source`).click();
  expect((await source).ok()).toBe(true);
  await expect(
    page.getByTestId('journal-page').getByText('A synthetic walk', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit this entry', exact: true })).toBeVisible();
  await page.goto(frontendUrl());
  await page.getByTestId('journal-notifications-open').click();
  const dismissed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/invitations/${String(id)}/dismiss`,
  );
  await page.getByTestId(`invitation-${String(id)}-dismiss`).click();
  expect((await dismissed).ok()).toBe(true);
  await expect(page.getByTestId(`invitation-${String(id)}`)).toHaveCount(0);
  const reloaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === '/invitations',
  );
  await page.reload();
  expect((await reloaded).ok()).toBe(true);
  await expect(page.getByTestId('journal-notification-center')).toBeVisible();
  await expect(page.getByTestId(`invitation-${String(id)}`)).toHaveCount(0);
});
