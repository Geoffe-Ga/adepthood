import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
 *  - A page is written and a timed writing session is run to the end. The
 *    finished session's "keep this" note is the one ring offer a fresh account
 *    can reach, and it showed with habits off before #3073. The spec waits for
 *    a positive settle point first: the note's withheld marker renders only
 *    after the offer has read its stored answer and found both depths
 *    declined. Only then does it assert that no accept or offer is there, so
 *    the absence cannot be read during the offer's own loading window. With
 *    the ring gate reverted, the offer renders instead of the marker and the
 *    spec fails on `save-as-habit-accept`.
 *  - The page is found by search, reopened, exported (both export routes, and
 *    the Export screen renders) and deleted.
 *  - Finally, the lane's fake language-model provider and fake Creek vault
 *    saw nothing from this journey: their counters are unchanged.
 *
 * What this spec deliberately does not assert. A fresh account has no habit
 * streak, no Return eligibility, no invitation row and no resonance pass, so
 * an absence check on the Return cards, invitation cards, the contraction
 * reflection or the link-a-habit pointer (which waits for an answered offer)
 * could not fail here and would only look like coverage. Those gates are
 * pinned where their data can be arranged: JournalShelfScreen.test.tsx and
 * InvitationStack.test.tsx (Return and invitation cards),
 * JournalEntryScreenContraction.test.tsx and
 * backend/tests/routers/test_contraction_reflection.py (contraction),
 * JournalEntryScreenTimer.test.tsx (link-a-habit pointer), and
 * backend/tests/routers/test_invitations.py (generation and listing).
 * `GET /invitations` is still read once, to cross the all-rings-off path of
 * the live route.
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
/** What the finished-session note would offer were either depth still kept. */
const SESSION_OFFERS = ['save-as-habit-accept', 'save-as-practice-accept', 'save-as-habit-offer'];
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

/**
 * Wait for the finished-session note to settle, then assert it offers nothing.
 *
 * The note renders nothing while it reads its stored answer, so an absence
 * check made right away would pass in that window whatever the gate does. The
 * wait is on the first of two positive signals: the withheld marker (the
 * gate's answer) or the offer itself (no gate). Whichever comes, the
 * assertions below then decide.
 */
async function expectSessionNoteWithheld(page: Page): Promise<void> {
  const banner = page.getByTestId('writing-session-banner');
  const settled = banner
    .getByTestId('writing-session-offer-withheld')
    .or(banner.getByTestId('save-as-habit-offer'));
  await expect(settled).toBeAttached();
  for (const testId of SESSION_OFFERS) {
    await expect(banner.getByTestId(testId)).toHaveCount(0);
  }
  await expect(banner.getByTestId('writing-session-offer-withheld')).toBeAttached();
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
  await expectSessionNoteWithheld(page);
  await visible(page, 'journal-close-entry').click();

  // --- Find it by search, and reopen it. ---
  // The shelf can stay mounted under another copy of itself after a page is
  // closed, so every shelf control is addressed by the copy on screen.
  await visible(page, 'search-toggle').click();
  await visible(page, 'search-input').fill(SEARCH_TERM);
  const found = visible(page, `journal-shelf-open-${entryId}`);
  await expect(found).toContainText(TITLE);
  await found.click();
  await expect(page.locator('[data-testid="journal-body-input"]:visible')).toHaveValue(BODY);
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

  // --- The live all-off listing answers empty, and nothing left the box. ---
  const invitations = await page.request.get(`${backendUrl()}/invitations`, { headers });
  expect(invitations.ok()).toBe(true);
  expect(await invitations.json()).toEqual([]);
  expect(await egressSnapshot(page.request)).toEqual(before);
});

const SETTINGS_LAYOUTS = [
  { width: 390, height: 844, scale: 1 },
  { width: 390, height: 844, scale: 2 },
  { width: 1280, height: 720, scale: 1 },
  { width: 1280, height: 720, scale: 2 },
];

/** Enlarge actual text while keeping the browser's viewport and hit targets physical. */
async function enlargeSettingsText(page: Page): Promise<void> {
  await page.getByTestId('settings-group-depths').evaluate((root) => {
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.childElementCount || !element.textContent?.trim()) continue;
      const style = getComputedStyle(element);
      element.style.fontSize = `${parseFloat(style.fontSize) * 2}px`;
      element.style.lineHeight = `${parseFloat(style.lineHeight) * 2}px`;
    }
  });
}

for (const layout of SETTINGS_LAYOUTS) {
  test(`a late depth read preserves a confirmed decline at ${layout.width} and ${layout.scale}x text`, async ({
    page,
  }) => {
    await page.setViewportSize(layout);
    const email = await signUp(page, 'depth-race');
    const { token } = await sessionFor(page.request, email);
    let release!: () => void;
    let captured!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const ready = new Promise<void>((done) => {
      captured = done;
    });
    let intercepted = false;
    await page.route('**/depth-preferences', async (route) => {
      if (route.request().method() !== 'GET' || intercepted) return route.continue();
      intercepted = true;
      // Fetch the genuine old server answer, delaying only its browser delivery.
      const response = await route.fetch();
      expect((await response.json()).enable_habits).toBe(true);
      captured();
      await held;
      await route.fulfill({ response });
    });
    await page.goto(`${frontendUrl()}/settings`);
    await ready;
    if (layout.scale === 2) await enlargeSettingsText(page);
    for (const ring of SWITCHED_IN_SETTINGS) {
      await expect(page.getByTestId(`depth-row-${ring}`).getByRole('switch')).toHaveCount(1);
    }
    const toggle = page.getByTestId('depth-toggle-habits').getByRole('switch');
    await expect(toggle).toBeChecked();
    await toggle.scrollIntoViewIfNeeded();
    await toggle.focus();
    await expect(toggle).toBeFocused();
    const patched = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === '/depth-preferences',
    );
    await page.keyboard.press('Space');
    expect((await patched).status()).toBe(HTTP_OK);
    await expect(toggle).not.toBeChecked();
    const delivered = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/depth-preferences',
    );
    release();
    await delivered;
    await page.waitForLoadState('networkidle');
    await expect(toggle).not.toBeChecked();
    const saved = await page.request.get(`${backendUrl()}/depth-preferences`, {
      headers: bearer(token),
    });
    expect((await saved.json()).enable_habits).toBe(false);
    const artifacts = join(__dirname, 'artifacts', 'decline-races');
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({
      path: join(artifacts, `settings-${layout.width}-${layout.scale}x.png`),
      animations: 'disabled',
    });
    for (const ring of ['practices', 'course']) {
      await page.keyboard.press('Tab');
      const nextToggle = page.getByTestId(`depth-toggle-${ring}`).getByRole('switch');
      await expect(nextToggle).toBeFocused();
      await expect(nextToggle).toBeInViewport();
    }
    await page.screenshot({
      path: join(artifacts, `settings-${layout.width}-${layout.scale}x-end.png`),
      animations: 'disabled',
    });
    await page.reload();
    await expect(toggle).not.toBeChecked();
    const restored = page.request.get(`${backendUrl()}/depth-preferences`, {
      headers: bearer(token),
    });
    expect((await (await restored).json()).enable_habits).toBe(false);
  });
}
