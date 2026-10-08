import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Issue #3072 — a sitting that was paused is saved whole.
 *
 * The completion window used to restamp its start on every transition into
 * `running`, resume included, so a sitting paused part-way posted
 * `started_at` = the last resume: a three-minute sit paused after one minute
 * was recorded, and counted by the server, as two. Jest substitutes pin the
 * window in isolation; this pins the seam, in a real browser against the real
 * server: the POST the page sends, and the `duration_minutes` the server
 * derives from it, are the practised time — pause excluded, nothing dropped.
 *
 * Time is Playwright's clock, installed before the app loads, so a sitting of
 * minutes runs in a few `fastForward` steps. It starts half an hour behind the
 * real clock: the server judges `ended_at` against its own clock and refuses a
 * sitting that ends in its future, and the fast-forwarded page must stay in
 * its past.
 */

/** A stage-1 alternative: a three-minute `meditation_timer` with no halfway bell. */
const TIMED_PRACTICE = 'Toe Wiggling';
const ENTRY_STAGE = 1;
const PLANNED_MINUTES = 3;
const MS_PER_MINUTE = 60_000;
/** How far behind the server's clock the page's clock starts. */
const CLOCK_LEAD_MS = 30 * MS_PER_MINUTE;

interface CatalogPractice {
  id: number;
  name: string;
  stage_number: number;
}

interface SavedSession {
  duration_minutes: number;
}

interface PostedSession {
  started_at: string;
  ended_at: string;
}

/** Adopt the timed practice over the API; choosing it is setup, not the subject. */
async function adoptTimedPractice(request: APIRequestContext, token: string): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  const listed = await request.get(`${backendUrl()}/practices/?stage_number=${ENTRY_STAGE}`, {
    headers,
  });
  if (!listed.ok()) throw new Error(`listing the stage-${ENTRY_STAGE} catalog failed`);
  const catalog = (await listed.json()) as CatalogPractice[];
  const practice = catalog.find((row) => row.name === TIMED_PRACTICE);
  if (!practice) throw new Error(`"${TIMED_PRACTICE}" is not in the stage-${ENTRY_STAGE} catalog`);
  const adopted = await request.post(`${backendUrl()}/user-practices/`, {
    headers,
    data: { practice_id: practice.id, stage_number: ENTRY_STAGE },
  });
  if (!adopted.ok()) throw new Error(`adopting "${TIMED_PRACTICE}" failed`);
}

async function openPractice(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Open \w+ menu$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Practice', exact: true }).click();
  await expect(page.getByTestId('meditation-timer-view')).toBeVisible();
}

test('a paused sitting is saved as the whole time practised', async ({ page }) => {
  await page.clock.install({ time: Date.now() - CLOCK_LEAD_MS });
  const email = await signUp(page, 'practice-paused-sitting');
  const token = await tokenFor(page.request, email);
  await adoptTimedPractice(page.request, token);
  await page.reload();
  await openPractice(page);

  await page.getByTestId('ritual-start').click();
  await page.clock.fastForward('01:00');
  await page.getByTestId('ritual-pause').click();
  // Five minutes away mid-sit: none of it is practice.
  await page.clock.fastForward('05:00');
  await page.getByTestId('ritual-resume').click();
  await page.clock.fastForward('02:30');
  await expect(page.getByTestId('insight-capture-modal')).toBeVisible();

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/practice-sessions/') && response.request().method() === 'POST',
  );
  await page.getByTestId('insight-skip').click();
  const response = await saved;
  expect(response.ok(), `the sitting was refused: ${await response.text()}`).toBe(true);

  const posted = response.request().postDataJSON() as PostedSession;
  const span = Date.parse(posted.ended_at) - Date.parse(posted.started_at);
  expect(span, 'the posted window is not the practised time').toBe(PLANNED_MINUTES * MS_PER_MINUTE);
  const session = (await response.json()) as SavedSession;
  expect(session.duration_minutes).toBe(PLANNED_MINUTES);
});
