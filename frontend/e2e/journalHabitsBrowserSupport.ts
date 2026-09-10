import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

import { readBrowserLaneState } from './browserState';
import { BACKEND_DIR, pythonExecutable, readLaneState } from './laneState';
import { freshLicenseKey } from './licenseKey';

const ACCOUNT_PHRASE = 'Journal-habits-browser-passphrase';
const START_DATE = '2026-01-01';
const HTTP_OK = 200;
const MS_PER_DAY = 86_400_000;
/** Length of the `YYYY-MM-DD` prefix of an ISO-8601 instant. */
const ISO_DATE_LENGTH = 10;

/** The calendar date `days` days before now, as the habit schema spells one. */
export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString().slice(0, ISO_DATE_LENGTH);
}

/**
 * How far back the program anchor goes so the calendar has carried an account
 * into the stage that opens the Return.
 *
 * The Return is offered from `domain.metta_return.RETURN_MINIMUM_STAGE` (5,
 * Orange) onward, and `constants/program.STAGE_DURATIONS_DAYS` gives the four
 * windows before it as 21 days each. Landing exactly on a window boundary is
 * what keeps this off the midnight edge: the rewind runs strictly before the
 * read, so a UTC midnight crossing between the two can only make the server
 * count one day more than asked for, never fewer.
 */
const DAYS_TO_RETURN_STAGE = 84;

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

/**
 * Move an account's program anchor `daysAgo` days back, so the stage calendar
 * has genuinely moved on.
 *
 * `program_started_at` is only ever written as "now" and no request schema
 * accepts it, so this arrange has to go to the lane's own throwaway database
 * through `tests.e2e.program_anchor` -- the same out-of-band rewind the Map
 * journey uses. It stubs nothing on the request path: the only thing faked is
 * the passage of time, and it is faked in the database rather than anywhere the
 * spec then reads through.
 */
export function setProgramAnchorDaysAgo(email: string, daysAgo: number): void {
  const state = readLaneState();
  if (state === null) throw new Error('API lane state is missing');
  const result = spawnSync(
    pythonExecutable(),
    ['-m', 'tests.e2e.program_anchor', 'anchor', '--email', email, '--days-ago', String(daysAgo)],
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

/** A week into the program: the anchor the promoted-quote reflection journey needs. */
const SIX_DAYS = 6;

export function setProgramAnchorSixDaysAgo(email: string): void {
  setProgramAnchorDaysAgo(email, SIX_DAYS);
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

/**
 * Ask a finished entry for its resonance, through the spend disclosure.
 *
 * A resonance pass is charged — one BotMason message — so the first press on an
 * account that has not set the note aside opens the cost disclosure instead of
 * running anything. These journeys are about what a pass produces, so they take
 * the Continue arm; the disclosure itself is the subject of
 * `resonance-explainer.browser.e2e.test.ts`.
 */
export async function askForResonance(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await page.getByTestId('resonance-explainer-continue').click();
}

/** Bearer header for a seeded token, as every out-of-band wire read sends one. */
export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** One week of the arc, as `GET /metta-return` projects it. */
export interface ReturnWeek {
  week_number: number;
  focus: string;
  title: string;
  framing: string;
}

/** The caller's active arc, as `GET /metta-return` projects it. */
export interface ReturnArc {
  started_at: string;
  paused: boolean;
  week: number;
  focus: string;
  complete: boolean;
}

/** One habit the caller set down in a Return, as `GET /metta-return` projects it. */
export interface ReleasedHabit {
  habit_id: number;
  name: string;
  icon: string;
  recommitted: boolean;
}

/** The Return surface the server reports for the caller. */
export interface ReturnState {
  eligible: boolean;
  weeks: ReturnWeek[];
  arc: ReturnArc | null;
  offer_dismissed: boolean;
  released_habits: ReleasedHabit[];
}

/** Read the Return surface out of band, so the browser's own state is never the witness. */
export async function readReturnState(
  request: APIRequestContext,
  token: string,
): Promise<ReturnState> {
  const response = await request.get(`${backendUrl()}/metta-return`, { headers: bearer(token) });
  expect(response.status()).toBe(HTTP_OK);
  return (await response.json()) as ReturnState;
}

/**
 * Carry the account into the stage that opens the Return, and prove the arrange
 * took.
 *
 * Eligibility is read before and after: an arrange that quietly did nothing
 * would otherwise leave every assertion downstream describing an account that
 * was never offered a Return at all.
 */
export async function reachReturnEligibility(
  request: APIRequestContext,
  token: string,
  email: string,
): Promise<void> {
  expect((await readReturnState(request, token)).eligible).toBe(false);
  setProgramAnchorDaysAgo(email, DAYS_TO_RETURN_STAGE);
  // Reading the Map is what records entry into the window the calendar opened;
  // the rewind alone moves the calendar and deliberately not the record.
  const visit = await request.get(`${backendUrl()}/stages`, { headers: bearer(token) });
  expect(visit.status()).toBe(HTTP_OK);
  expect((await readReturnState(request, token)).eligible).toBe(true);
}
