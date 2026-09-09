import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

import { readBrowserLaneState } from './browserState';
import { BACKEND_DIR, pythonExecutable, readLaneState } from './laneState';
import { freshLicenseKey } from './licenseKey';

const ACCOUNT_PHRASE = 'Journal-habits-browser-passphrase';
const START_DATE = '2026-01-01';

export function frontendUrl(): string {
  const state = readBrowserLaneState();
  if (state === null) throw new Error('browser E2E state is missing; global setup did not run');
  return state.frontendUrl;
}

export function backendUrl(): string {
  const state = readLaneState();
  if (state === null || state.baseUrl === '') {
    throw new Error('API lane state is missing; global setup did not boot a backend');
  }
  return state.baseUrl;
}

export function setProgramAnchorSixDaysAgo(email: string): void {
  const state = readLaneState();
  if (state === null) throw new Error('API lane state is missing');
  const result = spawnSync(
    pythonExecutable(),
    ['-m', 'tests.e2e.program_anchor', 'anchor', '--email', email, '--days-ago', '6'],
    {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: 'src', DATABASE_URL: state.databaseUrl },
    },
  );
  if (result.status !== 0) {
    throw new Error(`program anchor arrange failed: ${result.stderr || result.stdout}`);
  }
}

export async function signUp(page: Page, prefix: string): Promise<string> {
  const email = `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
  await page.goto(`${frontendUrl()}/get-started`);
  await page.getByRole('button', { name: 'I have a license key' }).click();
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(ACCOUNT_PHRASE);
  await page.getByRole('textbox', { name: 'Confirm password' }).fill(ACCOUNT_PHRASE);
  await page.getByRole('textbox', { name: 'Gumroad license key' }).fill(freshLicenseKey());
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Skip the welcome' }).click();
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  return email;
}

export async function tokenFor(request: APIRequestContext, email: string): Promise<string> {
  const login = await request.post(`${backendUrl()}/auth/login`, {
    data: { email, password: ACCOUNT_PHRASE },
  });
  if (!login.ok()) throw new Error(`seeding login failed with ${login.status()}`);
  return ((await login.json()) as { token: string }).token;
}

export async function seedHabit(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<number> {
  const response = await request.post(`${backendUrl()}/habits/`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name,
      icon: '★',
      start_date: START_DATE,
      energy_cost: 2,
      energy_return: 4,
    },
  });
  if (!response.ok()) throw new Error(`seeding ${name} failed with ${response.status()}`);
  return ((await response.json()) as { id: number }).id;
}

export async function openHabits(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Habits', exact: true }).click();
  await expect(page.getByTestId('habits-list')).toBeVisible();
}

export async function openReorder(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Habits menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByTestId('habit-tile').first().click();
  await page.getByTestId('habit-settings-reorder').click();
  await expect(page.getByTestId('reorder-modal-card')).toBeVisible();
}
