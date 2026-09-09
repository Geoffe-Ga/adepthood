import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Issue #2436 — Practice must not present its default stage as the user's own.
 *
 * The screen takes ONE automatic `GET /stages` per session. When that attempt
 * fails there is nothing in the store, so the stage number falls through to
 * `currentStage`'s initial value of 1 — and the old screen rendered it silently,
 * with no way to ask again from Practice. The claim under test is the honest
 * one: the number is named as a placeholder, the practice underneath it is
 * still usable, and the retry beside it is the *only* second request.
 *
 * This lives in the browser lane rather than the node lane for two reasons.
 * The node lane cannot mount a React Native screen at all (#2324), and the
 * invariant is about how many times a real client asks a real server — which
 * only a run with both halves present can count.
 */

/** The canonical stage-1 preset the fresh account adopts, so the player renders. */
const GROUNDING_PRACTICE = '5-4-3-2-1 grounding';
const ENTRY_STAGE = 1;
/** `stages.listAll` hits the collection route; the sibling `/stages/...` reads are untouched. */
const isStageList = (url: URL): boolean => url.pathname === '/stages';

interface CatalogPractice {
  id: number;
  name: string;
  stage_number: number;
}

/** Adopt the stage-1 grounding practice over the API: setup, not the subject. */
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

/** Cross to Practice through the screen drawer; the toggle is the proof of arrival. */
async function openPractice(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Open \w+ menu$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Practice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Practice menu' })).toBeVisible();
}

test('a stage Practice could not load is named, not passed off as stage 1', async ({ page }) => {
  const email = await signUp(page, 'practice-unconfirmed-stage');
  const token = await tokenFor(page.request, email);
  await adoptGroundingPractice(page.request, token);

  // Counted rather than pinned to an exact baseline: what the guard promises is
  // that the retry adds exactly one request, whatever else the shell asked for.
  let stageRequests = 0;
  page.on('request', (request) => {
    if (isStageList(new URL(request.url()))) stageRequests += 1;
  });

  // The failure under test. A 503 stands in for the whole class the fall-through
  // swallowed -- a timeout, a cold backend, a dropped connection -- because every
  // one of them leaves the store in the same shape: attempted, and empty.
  await page.route(isStageList, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'stages unavailable' }),
    });
  });
  await page.reload();
  await openPractice(page);

  const notice = page.getByTestId('practice-stage-unconfirmed');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('placeholder');
  // Not a wall: the practice the account adopted is still on the screen and
  // still startable, which is the whole reason this is a strip and not an
  // ErrorView.
  await expect(page.getByTestId('ritual-start')).toBeVisible();

  const beforeRetry = stageRequests;
  await page.unroute(isStageList);
  await page.getByRole('button', { name: 'Try again' }).click();

  // The stages arrive, so the screen stops calling its number a placeholder --
  // in the same page load, with the session that was on screen still on screen.
  await expect(notice).toBeHidden();
  await expect(page.getByTestId('ritual-start')).toBeVisible();
  expect(stageRequests).toBe(beforeRetry + 1);
});
