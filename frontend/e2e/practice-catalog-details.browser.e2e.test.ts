import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Issue #2451 — a practice's details open in place over the Practice tab's
 * embedded catalog, and declining them leaves the catalog as it was.
 *
 * The browser lane is the only one that can hold this claim. The node lane
 * cannot mount a screen (#2324), and the Jest suite mocks the client, so
 * neither can show that a row on the catalog a practitioner actually reaches
 * opens the overlay against the real `GET /practices/{practice_id}`, that the
 * web's Escape key closes it (react-native-web routes it to the Modal's
 * `onRequestClose`), or that choosing the practice there writes a real
 * adoption the player then shows.
 *
 * The same walk crosses the in-place Practice | Catalog flip in both
 * directions, which cross-fades (#1952): each time, the surface left behind
 * must actually unmount once the fade completes under the browser's own
 * animation driver.
 *
 * The overlay is not a route, so the browser's back button leaves the tab
 * rather than closing it. That is an accepted limitation, and this spec does
 * not assert anything about the URL.
 */

/** The canonical stage-1 preset; `sense_grounding` mode. */
const GROUNDING_PRACTICE = '5-4-3-2-1 grounding';
const ENTRY_STAGE = 1;
/** Narrows the catalog to the grounding preset, so its row is on screen. */
const SEARCH_TEXT = 'grounding';

interface CatalogPractice {
  id: number;
  name: string;
}

/** The grounding preset's catalog id, read over the API. */
async function groundingPracticeId(request: APIRequestContext, token: string): Promise<number> {
  const listed = await request.get(`${backendUrl()}/practices/?stage_number=${ENTRY_STAGE}`, {
    headers: bearer(token),
  });
  if (!listed.ok()) throw new Error(`listing the stage-${ENTRY_STAGE} catalog failed`);
  const catalog = (await listed.json()) as CatalogPractice[];
  const grounding = catalog.find((practice) => practice.name === GROUNDING_PRACTICE);
  if (!grounding) {
    throw new Error(`"${GROUNDING_PRACTICE}" is not in the stage-${ENTRY_STAGE} catalog`);
  }
  return grounding.id;
}

/** Reach the Practice tab through the screen drawer, as a person would. */
async function openPracticeTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Open \w+ menu$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Practice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Practice menu' })).toBeVisible();
}

test('a practice opens in place over the embedded catalog, and declining it keeps the catalog', async ({
  page,
}) => {
  const email = await signUp(page, 'practice-catalog-details');
  const token = await tokenFor(page.request, email);
  const practiceId = await groundingPracticeId(page.request, token);
  const row = page.getByTestId(`practice-catalog-row-${practiceId}`);
  const overlay = page.getByTestId('practice-detail-overlay');
  const search = page.getByTestId('practice-catalog-search');

  await openPracticeTab(page);
  await expect(page.getByTestId('practice-empty-state')).toBeVisible();
  await page.getByTestId('practice-tab-catalog').click();
  await expect(page.getByTestId('practice-embedded-catalog')).toBeVisible();
  // The flip cross-fades (#1952), and the surface it leaves is gone once the
  // fade completes in a real browser's driver, not merely hidden.
  await expect(page.getByTestId('practice-empty-state')).toHaveCount(0);
  await search.fill(SEARCH_TEXT);
  await expect(row).toBeVisible();

  // Open in place: the details arrive from the real endpoint, over the catalog.
  await row.click();
  await expect(overlay).toBeVisible();
  await expect(overlay.getByTestId('practice-detail-name')).toHaveText(GROUNDING_PRACTICE);

  // Decline with the keyboard. react-native-web hands Escape only to the
  // Modal that has finished presenting, which is when it takes the dialog
  // role, so the key waits for that rather than racing the slide-in. The
  // catalog under it is untouched, and focus goes back to the row that opened
  // it.
  await expect(page.getByRole('dialog').filter({ has: overlay })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await expect(search).toHaveValue(SEARCH_TEXT);
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();

  // Choose it from the overlay: assign at its home stage, then the player.
  await row.click();
  await expect(overlay.getByTestId('practice-detail-name')).toHaveText(GROUNDING_PRACTICE);
  await overlay.getByTestId('practice-detail-use-for-stage').click();
  await overlay.getByTestId(`practice-detail-stage-pick-${ENTRY_STAGE}`).click();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId('practice-identity-title')).toHaveText(GROUNDING_PRACTICE);
  await expect(page.getByTestId('practice-embedded-catalog')).toHaveCount(0);

  // The server agrees the adoption is real, not just painted.
  const adopted = await page.request.get(`${backendUrl()}/user-practices/`, {
    headers: bearer(token),
  });
  expect(adopted.ok()).toBe(true);
  const rows = (await adopted.json()) as Array<{ practice_id: number; stage_number: number }>;
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ practice_id: practiceId, stage_number: ENTRY_STAGE }),
    ]),
  );
});
