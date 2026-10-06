import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl, sessionFor, signUp } from './journalHabitsBrowserSupport';
import { readLaneState, type LaneState } from './laneState';

/**
 * #3073: someone who declines every optional depth can still keep a journal,
 * and is never pulled back toward a ring they turned off.
 *
 * Crossed end to end in a real browser against a live server, on a fresh
 * account: no corpus consent, no vault of its own, not the deployment vault's
 * bound owner.
 *
 *  - Habits, Practices and Course are switched off in Settings through the
 *    real switches (each a live `PATCH /depth-preferences`). Sangha's switch is
 *    offered only in a build with a Sangha invite URL, which this lane's bundle
 *    may not have, so it is declined over HTTP and read back, which is the
 *    same server state the switch would write.
 *  - The drawer then lists no Habits, Practice or Course destination.
 *  - A page is written and a timed writing session is run to the end. This is
 *    the one offer that showed with habits off before #3073 (the finished
 *    session's "keep this as a habit"), so the path is not vacuous: with both
 *    habits and practices declined, the note carries no offer and no
 *    link-a-habit pointer.
 *  - The page is found by search, reopened, exported (both export routes, and
 *    the Export screen renders) and deleted.
 *  - Throughout, the shelf shows no Return or invitation card and the entry no
 *    contraction reflection; `GET /invitations` is empty.
 *  - Finally, the lane's fake language-model provider and fake Creek vault
 *    saw nothing from this journey: their counters are unchanged.
 *
 * Time is Playwright's clock, as in `journal-unlinked-timer-nudge`.
 */

const TITLE = 'Only the page';
const BODY = 'A kettle, a window, and nothing else asked of me this morning.';
const SEARCH_TERM = 'kettle';
/** Past the default twenty-minute session, so the next tick lands it complete. */
const PAST_A_SESSION = '20:05';
const RINGS_OFF = {
  enable_habits: false,
  enable_practices: false,
  enable_course: false,
  enable_sangha: false,
};
/** The Settings switches this lane's bundle always offers, by their testID slug. */
const SWITCHED_IN_SETTINGS = ['habits', 'practices', 'course'] as const;
/** Drawer destinations that belong to a declinable ring. */
const RING_DESTINATIONS = ['Habits', 'Practice', 'Course'] as const;
/** Every surface that invites the writer back into a ring. */
const RING_PROMPTS = [
  'save-as-habit-offer',
  'save-as-habit-accept',
  'save-as-practice-accept',
  'link-habit-nudge',
  'contraction-reflection',
] as const;
const HTTP_OK = 200;

function lane(): LaneState {
  const state = readLaneState();
  if (state === null) throw new Error('API lane state is missing; global setup did not run');
  return state;
}

/** Both fakes' arrival records, read so a later read can be compared whole. */
async function egressSnapshot(request: APIRequestContext): Promise<unknown[]> {
  const { providerUrl, vaultUrl, vaultApiKey } = lane();
  const attempts = await request.get(`${providerUrl}/__lane/attempts`);
  expect(attempts.status()).toBe(HTTP_OK);
  const uploads = await request.get(`${vaultUrl}/__lane/uploads`, {
    headers: bearer(vaultApiKey),
  });
  expect(uploads.status()).toBe(HTTP_OK);
  return [await attempts.json(), await uploads.json()];
}

/** The on-screen copy of a testID, when a hidden screen beneath also carries it. */
function visible(page: Page, testId: string): Locator {
  return page.locator(`[data-testid="${testId}"]:visible`);
}

/** No ring prompt of any kind is on the page. */
async function expectNoRingPrompt(page: Page): Promise<void> {
  for (const testId of RING_PROMPTS) {
    await expect(page.getByTestId(testId)).toHaveCount(0);
  }
  await expect(page.getByTestId(/^(return|invitation)-/u)).toHaveCount(0);
}

async function declineEveryRing(page: Page, headers: Record<string, string>): Promise<void> {
  await page.goto(`${frontendUrl()}/settings`);
  const depths = page.getByTestId('settings-group-depths');
  for (const ring of SWITCHED_IN_SETTINGS) {
    // On web the Switch is a wrapper carrying the testID around the native
    // checkbox that carries the state; address the checkbox inside it.
    const toggle = depths.getByTestId(`depth-toggle-${ring}`).getByRole('switch');
    await expect(toggle).toBeChecked();
    const patched = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === '/depth-preferences',
    );
    await toggle.click();
    expect((await patched).ok()).toBe(true);
    await expect(toggle).not.toBeChecked();
  }
  const sangha = await page.request.patch(`${backendUrl()}/depth-preferences`, {
    headers,
    data: { enable_sangha: false },
  });
  expect(sangha.ok()).toBe(true);
  const stored = await page.request.get(`${backendUrl()}/depth-preferences`, { headers });
  expect(await stored.json()).toMatchObject(RINGS_OFF);
}

async function runASession(page: Page): Promise<void> {
  const folded = page.getByRole('button', { name: 'Open writing timer options' });
  if (await folded.isVisible()) await folded.click();
  await page.getByTestId('writing-timer-start').click();
  await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
  await page.clock.fastForward(PAST_A_SESSION);
  await expect(page.getByTestId('writing-session-banner')).toBeVisible();
}

test('a writer who declines every depth keeps a whole journal and is offered no ring', async ({
  page,
}) => {
  await page.clock.install();
  const email = await signUp(page, 'journal-only');
  const { token } = await sessionFor(page.request, email);
  const headers = bearer(token);
  const before = await egressSnapshot(page.request);

  await declineEveryRing(page, headers);

  // --- The drawer offers no destination for a declined ring. ---
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('button', { name: 'Journal', exact: true })).toBeVisible();
  for (const name of RING_DESTINATIONS) {
    await expect(drawer.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await page.keyboard.press('Escape');
  await expectNoRingPrompt(page);

  // --- Write a page, and run a timed session to its end. ---
  await visible(page, 'journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill(TITLE);
  await page.getByTestId('journal-body-input').fill(BODY);
  const entryId = ((await (await created).json()) as { id: number }).id;
  await runASession(page);
  await expectNoRingPrompt(page);
  await visible(page, 'journal-close-entry').click();

  // --- Find it by search, and reopen it. ---
  // The shelf can stay mounted under another copy of itself after a page is
  // closed, so every shelf control is addressed by the copy on screen.
  await visible(page, 'search-toggle').click();
  await visible(page, 'search-input').fill(SEARCH_TERM);
  const found = visible(page, `journal-shelf-open-${entryId}`);
  await expect(found).toContainText(TITLE);
  await expectNoRingPrompt(page);
  await found.click();
  await expect(page.locator('[data-testid="journal-body-input"]:visible')).toHaveValue(BODY);
  await expectNoRingPrompt(page);
  await visible(page, 'journal-close-entry').click();

  // --- Export: both routes carry the page, and the screen renders. ---
  const archive = await page.request.get(`${backendUrl()}/users/me/export`, { headers });
  expect(archive.ok()).toBe(true);
  expect(JSON.stringify(await archive.json())).toContain(BODY);
  const markdown = await page.request.get(`${backendUrl()}/users/me/export/journal.md`, {
    headers,
  });
  expect(markdown.ok()).toBe(true);
  expect(await markdown.text()).toContain(BODY);
  await page.goto(`${frontendUrl()}/settings`);
  await page.getByTestId('settings-row-export-data').click();
  await expect(page.getByTestId('export-data-screen')).toBeVisible();

  // --- Delete it. ---
  await page.goto(`${frontendUrl()}/journal`);
  await visible(page, `journal-shelf-delete-${entryId}`).click();
  await visible(page, 'journal-delete-confirm').click();
  await expect(page.getByTestId(`journal-shelf-open-${entryId}`)).toHaveCount(0);
  await expectNoRingPrompt(page);

  // --- Nothing was offered, and nothing left the box. ---
  const invitations = await page.request.get(`${backendUrl()}/invitations`, { headers });
  expect(invitations.ok()).toBe(true);
  expect(await invitations.json()).toEqual([]);
  expect(await egressSnapshot(page.request)).toEqual(before);
});
