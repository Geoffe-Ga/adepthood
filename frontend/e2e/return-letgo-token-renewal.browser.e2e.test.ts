import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';

import {
  askForResonance,
  backendUrl,
  bearer,
  frontendUrl,
  isoDaysAgo,
  readReturnState,
  reachReturnEligibility,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

// A routed read can still be awaiting `route.fetch()` when the test ends, and
// that fetch then rejects with "Test ended" outside any test (#3481). Unroute
// first so a straggler's late error is dropped rather than failing the run.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

/**
 * #3374: the let-go prompt that follows beginning a Return stays open, with the
 * person's half-made choice, while the app renews the same account's token.
 *
 * `useReturnScope` mints a new staleness fence every time `AuthContext`
 * rotates the JWT, and the let-go card's visibility used to reset on that
 * fence. A proactive same-account renewal landing while the person was
 * choosing which habits to set down therefore unmounted `ReturnLetGoCard`, and
 * the active-arc card offers no way back to it. Jest pins the hook and the
 * mounted stack against controlled credentials
 * (`useMettaReturnOwnership.test.tsx`, `ReturnStackTokenRenewal.test.tsx`);
 * only the browser can show the real `AuthContext` renewal reaching the real
 * Journal shelf.
 *
 * The renewal is the production proactive one, not a stub: the page clock
 * jumps past the token's sliding-renewal deadline, the app's own timer issues
 * `POST /auth/refresh`, and the live server rotates the token. The response is
 * held only while the page clock is set back to the present, so the fresh
 * token is not immediately judged due again by a clock still running two weeks
 * ahead of the server that minted it.
 */

/** Past the sliding-renewal point of the backend's 30-day token: half, plus a margin. */
const PAST_RENEWAL_DEADLINE_MS = (15 * 24 * 60 + 5) * 60 * 1000;

/** Long enough ago that the quiet foundation names a contraction (the window is 14 days). */
const QUIET_FOUNDATION_DAYS = 30;

const OK = 200;
const CREATED = 201;
const RETURN_OFFER_TITLE = 'The Return is open to you';
const KEPT_HABIT = 'Morning sit';
const RESTED_HABIT = 'Evening stillness';

/**
 * The Journal shelf the person is looking at. Opening an entry and closing it
 * can leave an earlier shelf mounted behind the visible one, each with its own
 * Return surface, so every Return locator is scoped to what is on screen.
 */
function shown(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

async function seedRevealedHabit(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<number> {
  const response = await request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name,
      icon: '★',
      start_date: isoDaysAgo(QUIET_FOUNDATION_DAYS),
      energy_cost: 2,
      energy_return: 4,
      revealed: true,
    },
  });
  expect(response.status()).toBe(OK);
  return ((await response.json()) as { id: number }).id;
}

async function seedFinishedEntry(request: APIRequestContext, token: string): Promise<number> {
  const created = await request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: {
      title: 'A quiet fortnight',
      message: 'The willow bent all night and did not break. I slept badly and woke grateful.',
    },
  });
  expect(created.status()).toBe(CREATED);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(OK);
  return entryId;
}

interface Arranged {
  token: string;
  restedId: number;
}

/** Raise the contraction through a real resonance pass, then begin the Return on the shelf. */
async function beginReturnOnShelf(page: Page, prefix: string): Promise<Arranged> {
  const email = await signUp(page, prefix);
  const token = await tokenFor(page.request, email);
  await reachReturnEligibility(page.request, token, email);
  await seedRevealedHabit(page.request, token, KEPT_HABIT);
  const restedId = await seedRevealedHabit(page.request, token, RESTED_HABIT);
  const entryId = await seedFinishedEntry(page.request, token);
  await page.goto(`${frontendUrl()}/journal`);
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await askForResonance(page);
  await expect(page.getByTestId('contraction-reflection-title')).toHaveText(RETURN_OFFER_TITLE);
  await page.getByTestId('journal-close-entry').click();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/metta-return/arc',
  );
  await shown(page, 'return-offer-accept').click();
  expect((await started).status()).toBe(CREATED);
  await expect(shown(page, `return-letgo-habit-${String(restedId)}`)).toBeVisible();
  return { token, restedId };
}

/**
 * Let the app's own proactive timer renew the session, and return the token the
 * live server minted for it.
 */
async function renewSameAccountToken(page: Page): Promise<string> {
  const present = await page.evaluate(() => Date.now());
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const minted: string[] = [];
  const reads: Promise<unknown> = page.waitForRequest(
    (request) =>
      request.method() === 'GET' &&
      new URL(request.url()).pathname === '/metta-return' &&
      minted.length === 1 &&
      request.headers().authorization === `Bearer ${minted[0]}`,
  );
  const held = new Promise<void>((arrived) => {
    void page.route('**/auth/refresh', async (route: Route) => {
      arrived();
      await released;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      minted.push(((await response.json()) as { token: string }).token);
      await route.fulfill({ response });
    });
  });
  await page.clock.fastForward(PAST_RENEWAL_DEADLINE_MS);
  await held;
  await page.clock.setSystemTime(present);
  release();
  // The renewed credential is in use once the Return surface re-reads with it.
  await reads;
  await page.unroute('**/auth/refresh');
  return minted[0] ?? '';
}

async function captureLetGo(page: Page, width: number, label: string): Promise<void> {
  const artifacts = join(process.cwd(), 'e2e/artifacts/return-letgo-renewal-3374');
  mkdirSync(artifacts, { recursive: true });
  const card = shown(page, 'return-letgo-card');
  await card.evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({
    path: join(artifacts, `letgo-${String(width)}-${label}.png`),
    animations: 'disabled',
  });
}

/** Double the card's own rendered text and prove no glyph leaves the card. */
async function enlargeLetGoText(page: Page): Promise<void> {
  const card = shown(page, 'return-letgo-card');
  const overflow = await card.evaluate((root) => {
    const texts = Array.from(root.querySelectorAll<HTMLElement>('[dir="auto"]')).filter((node) =>
      node.textContent?.trim(),
    );
    for (const node of texts) {
      const style = getComputedStyle(node);
      const line = Number.parseFloat(style.lineHeight);
      node.style.fontSize = `${Number.parseFloat(style.fontSize) * 2}px`;
      node.style.lineHeight = Number.isFinite(line) ? `${line * 2}px` : '1.5';
    }
    const bounds = root.getBoundingClientRect();
    return texts
      .flatMap((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return Array.from(range.getClientRects());
      })
      .filter((box) => box.left < bounds.left - 1 || box.right > bounds.right + 1)
      .map((box) => `${String(box.left)}..${String(box.right)}`);
  });
  expect(overflow).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

for (const width of [390, 1280]) {
  test(`a same-account renewal keeps the let-go choice open and releases it with the renewed token at ${String(width)}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    const { token, restedId } = await beginReturnOnShelf(page, `return-letgo-renewal-${width}`);
    const choice = shown(page, `return-letgo-habit-${String(restedId)}`);
    // Release goes live only once something is chosen, so its state is the
    // card's own record of the half-made choice: a remount would reset it.
    const releaseButton = shown(page, 'return-letgo-release');
    await expect(releaseButton).toBeDisabled();
    await choice.click();
    await expect(releaseButton).toBeEnabled();
    await captureLetGo(page, width, 'chosen');

    const renewed = await renewSameAccountToken(page);
    expect(renewed).not.toBe('');
    expect(renewed).not.toBe(token);

    await expect(shown(page, 'return-letgo-card')).toBeVisible();
    await expect(releaseButton).toBeEnabled();
    await expect(shown(page, 'return-arc-card')).toHaveCount(0);
    await captureLetGo(page, width, 'after-renewal');
    await enlargeLetGoText(page);
    await captureLetGo(page, width, 'after-renewal-200-text');

    const releasing = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/metta-return/arc/release',
    );
    await releaseButton.click();
    const release = await releasing;
    expect(release.headers().authorization).toBe(`Bearer ${renewed}`);
    expect(release.postDataJSON()).toEqual({ habit_ids: [restedId] });
    await expect(shown(page, 'return-arc-card')).toBeVisible();
    await expect(shown(page, 'return-letgo-card')).toHaveCount(0);
    const after = await readReturnState(page.request, token);
    expect(after.released_habits.map((row) => row.habit_id)).toEqual([restedId]);
  });
}

test('"Keep them all" still closes the let-go choice after a same-account renewal', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const releases: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/metta-return/arc/release') {
      releases.push(request.url());
    }
  });
  const { token } = await beginReturnOnShelf(page, 'return-letgo-renewal-keep');
  await renewSameAccountToken(page);
  await expect(shown(page, 'return-letgo-card')).toBeVisible();
  await shown(page, 'return-letgo-skip').click();
  await expect(shown(page, 'return-arc-card')).toBeVisible();
  await expect(shown(page, 'return-letgo-card')).toHaveCount(0);
  expect(releases).toHaveLength(0);
  expect((await readReturnState(page.request, token)).released_habits).toEqual([]);
});
