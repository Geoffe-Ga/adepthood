import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl } from './journalHabitsBrowserSupport';

/**
 * Shared drivers for the beta-feedback browser journeys (#2898, #2899).
 *
 * Deliberately does NOT re-export `signUp`: the lane guard requires each spec
 * to import its signup driver from the literal './journalHabitsBrowserSupport',
 * so the guard can read the real `Create account` press.
 */

export const WIDE_VIEWPORT = { width: 1280, height: 720 };
export const NARROW_VIEWPORT = { width: 390, height: 844 };
/** Upper bound on Tab presses to reach a control, so a lost focus fails fast. */
const MAX_TAB_PRESSES = 60;
export const PUBLIC_ID = /^FB-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
export const HTTP_OK = 200;
export const HTTP_INTERNAL_SERVER_ERROR = 500;
export const HTTP_UNPROCESSABLE = 422;
export const HTTP_TOO_MANY = 429;

const FEEDBACK_PATH = '/feedback/';
const JOURNAL_LIST_PATH = '/journal/';
const IDEMPOTENCY_HEADER = 'idempotency-key';
/** The preview row testIDs are `feedback-attached-<key>`; the container is not a row. */
const PREVIEW_ROW_PREFIX = 'feedback-attached-';
const PREVIEW_CONTAINER = 'feedback-attached-preview';
/** Each preview row reads `<Label>: <value>`. */
const PREVIEW_SEPARATOR = ': ';

/** The visible header control on the focused screen. */
export function feedbackControl(page: Page): Locator {
  return page.getByRole('button', { name: 'Send feedback' }).filter({ visible: true });
}

/** Press Tab until `target` holds focus. Keyboard only; bounded so it cannot spin. */
export async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < MAX_TAB_PRESSES; presses += 1) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${target.toString()}`);
}

export async function typeInto(page: Page, testID: string, text: string): Promise<void> {
  await tabTo(page, page.getByTestId(testID));
  await page.keyboard.type(text);
}

export async function readReference(page: Page): Promise<string> {
  const reference = page.getByTestId('feedback-reference');
  await expect(reference).toHaveText(PUBLIC_ID);
  return (await reference.textContent()) ?? '';
}

/** One POST to the intake route, as the page sent it. */
export interface CapturedPost {
  idempotencyKey: string | undefined;
  body: { context: Record<string, unknown> } & Record<string, unknown>;
}

function isIntakePost(url: string, method: string): boolean {
  return method === 'POST' && new URL(url).pathname === FEEDBACK_PATH;
}

/**
 * Record every POST /feedback/ the page puts on the wire, from now on.
 * Counted at `request`, before any route handler decides its fate, so a
 * request that is later held, aborted or fulfilled still counts as sent.
 */
export function captureFeedbackPosts(page: Page): CapturedPost[] {
  const posts: CapturedPost[] = [];
  page.on('request', (request) => {
    if (!isIntakePost(request.url(), request.method())) return;
    posts.push({
      idempotencyKey: request.headers()[IDEMPOTENCY_HEADER],
      body: request.postDataJSON() as CapturedPost['body'],
    });
  });
  return posts;
}

/** Route only the intake POST; every other request goes on untouched. */
export async function routeIntake(
  page: Page,
  handler: Parameters<Page['route']>[1],
): Promise<void> {
  await page.route(
    (url) => url.pathname === FEEDBACK_PATH,
    async (route, request) => {
      if (request.method() === 'POST') await handler(route, request);
      else await route.fallback();
    },
  );
}

/**
 * The key/value pairs the composer shows under "What will be attached", keyed
 * by the envelope key its row testID names -- the same keys the request sends.
 */
export async function readPreviewContext(page: Page): Promise<Record<string, string>> {
  const rows = page
    .getByTestId(PREVIEW_CONTAINER)
    .locator(`[data-testid^="${PREVIEW_ROW_PREFIX}"]:not([data-testid="${PREVIEW_CONTAINER}"])`);
  const shown: Record<string, string> = {};
  for (const row of await rows.all()) {
    const testID = (await row.getAttribute('data-testid')) ?? '';
    const text = (await row.textContent()) ?? '';
    const cut = text.indexOf(PREVIEW_SEPARATOR);
    shown[testID.slice(PREVIEW_ROW_PREFIX.length)] = text.slice(cut + PREVIEW_SEPARATOR.length);
  }
  return shown;
}

/** The wire context, stringified value by value, for comparison with the preview. */
export function asShown(context: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(context).map(([key, value]) => [key, String(value)]));
}

/** How many reports the server holds for this account, read from its own export. */
export async function feedbackReportCount(
  request: APIRequestContext,
  token: string,
): Promise<number> {
  const response = await request.get(`${backendUrl()}/users/me/export`, { headers: bearer(token) });
  expect(response.status()).toBe(HTTP_OK);
  const archive = (await response.json()) as { records: Record<string, unknown[] | undefined> };
  return archive.records.feedback_reports?.length ?? 0;
}

/** Fail the Journal shelf's list load with a 500, leaving every other call real. */
export async function plantJournalFailure(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === JOURNAL_LIST_PATH,
    async (route, request) => {
      if (request.method() !== 'GET') await route.fallback();
      else
        await route.fulfill({
          status: HTTP_INTERNAL_SERVER_ERROR,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'planted_journal_failure' }),
        });
    },
  );
}

/** The tab routes the composer can be opened from, by their linked paths. */
export type OriginPath = 'journal' | 'habits' | 'practice' | 'course' | 'map' | 'settings';

/**
 * Land on `path` and open the composer from the control that screen offers:
 * the header control on a tab, the Settings row on Settings.
 */
export async function openComposerFrom(page: Page, path: OriginPath): Promise<void> {
  await page.goto(`${frontendUrl()}/${path}`);
  if (path === 'settings') {
    await page.getByTestId('settings-row-feedback').click();
  } else {
    await feedbackControl(page).click();
  }
  await expect(page.getByTestId('feedback-composer-heading')).toBeVisible();
}

/** Choose "Something broke" and answer every question it asks, by pointer. */
export async function fillBrokenReport(page: Page, summary: string): Promise<void> {
  await page.getByRole('radio', { name: 'Something broke' }).click();
  await page.getByTestId('feedback-field-summary').fill(summary);
  await page.getByTestId('feedback-field-intent').fill('Open my journal shelf');
  await page.getByTestId('feedback-field-expected').fill('My pages to be listed');
  await page.getByTestId('feedback-field-actual').fill('The shelf said it could not load');
  await page.getByRole('radio', { name: 'I could carry on' }).click();
}
