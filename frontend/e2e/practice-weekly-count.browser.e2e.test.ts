import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Issue #2654 — the weekly bar has to move when a practice is saved.
 *
 * This journey lives in the browser lane rather than the node lane because the
 * defect was never in either half of the wire: the client refetched, the server
 * counted, and both suites were green while the number on screen stayed wrong.
 * What went wrong sat *between* them — the rollup response advertised a
 * one-minute freshness lifetime, so Chromium answered the post-save refetch out
 * of its own HTTP cache with the pre-save number. Only a real browser talking to
 * a real server can see that, which is exactly what this lane is.
 */

/** The canonical stage-1 preset; `sense_grounding` mode, five stepped prompts. */
const GROUNDING_PRACTICE = '5-4-3-2-1 grounding';
const ENTRY_STAGE = 1;
/** Sight, touch, hearing, smell, taste: one advance tap each completes the ritual. */
const SENSE_STEPS = 5;
const WEEKLY_TARGET = 4;

interface CatalogPractice {
  id: number;
  name: string;
  stage_number: number;
}

/**
 * Adopt the stage-1 grounding practice over the API so the journey below starts
 * on the player rather than on the catalog. The screen under test is the save →
 * count return path; choosing the practice is setup, not the subject.
 */
async function adoptGroundingPractice(request: APIRequestContext, token: string): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  const listed = await request.get(`${backendUrl()}/practices/?stage_number=${ENTRY_STAGE}`, {
    headers,
  });
  if (!listed.ok()) throw new Error(`listing the stage-${ENTRY_STAGE} catalog failed`);
  const catalog = (await listed.json()) as CatalogPractice[];
  const grounding = catalog.find((practice) => practice.name === GROUNDING_PRACTICE);
  if (!grounding) {
    throw new Error(`"${GROUNDING_PRACTICE}" is not in the stage-${ENTRY_STAGE} catalog`);
  }
  const adopted = await request.post(`${backendUrl()}/user-practices/`, {
    headers,
    data: { practice_id: grounding.id, stage_number: ENTRY_STAGE },
  });
  if (!adopted.ok()) throw new Error(`adopting "${GROUNDING_PRACTICE}" failed`);
}

/**
 * Cross to another primary destination through the screen drawer. Each screen's
 * own drawer toggle is labelled after it, so the toggle is both the way in and
 * the proof of arrival.
 */
async function navigateTo(page: Page, screen: 'Journal' | 'Practice'): Promise<void> {
  await page.getByRole('button', { name: /^Open \w+ menu$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: screen, exact: true }).click();
  await expect(page.getByRole('button', { name: `Open ${screen} menu` })).toBeVisible();
}

async function openPractice(page: Page): Promise<void> {
  await navigateTo(page, 'Practice');
  await expect(page.getByTestId('active-ritual-session')).toBeVisible();
}

/** Run the ritual end to end and save it with a one-line insight. */
async function completeAndSaveGrounding(page: Page, insight: string): Promise<void> {
  await page.getByTestId('ritual-start').click();
  for (let step = 0; step < SENSE_STEPS; step += 1) {
    await page.getByTestId('sense-grounding-advance').click();
  }
  await expect(page.getByTestId('insight-capture-modal')).toBeVisible();
  await page.getByTestId('insight-input').fill(insight);
  await page.getByTestId('insight-save').click();
  await expect(page.getByTestId('insight-capture-modal')).toBeHidden();
}

test('saving a grounding session moves the weekly count without a reload', async ({ page }) => {
  const email = await signUp(page, 'practice-weekly-count');
  const token = await tokenFor(page.request, email);
  await adoptGroundingPractice(page.request, token);
  await page.reload();
  await openPractice(page);

  const weekCount = page.getByTestId('week-count-text');
  await expect(weekCount).toHaveText(`0 of ${WEEKLY_TARGET}`);

  await completeAndSaveGrounding(page, 'The floor was holding me the whole time.');

  // The server has the row: a failure below is a display failure, not a lost save.
  const persisted = await page.request.get(`${backendUrl()}/practice-sessions/week-count`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect((await persisted.json()) as { count: number }).toEqual({ count: 1 });

  // The number the practitioner is looking at, in the same page load.
  await expect(weekCount).toHaveText(`1 of ${WEEKLY_TARGET}`);

  // And it survives the screen's own authoritative re-read. Leaving the screen
  // and coming back is the cheapest way to force one without a reload; before
  // the fix this is where the cached pre-save rollup put the bar back to zero.
  await navigateTo(page, 'Journal');
  await openPractice(page);
  await expect(weekCount).toHaveText(`1 of ${WEEKLY_TARGET}`);
});
