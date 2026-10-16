import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test';

import {
  askForResonance,
  backendUrl,
  bearer,
  frontendUrl,
  isoDaysAgo,
  reachReturnEligibility,
  readReturnState,
  seedHabit,
  seedTimerHabit,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * #3452: work that crosses a same-account token renewal still lands, on the
 * three surfaces that used to fence it on the exact JWT.
 *
 * - Settings' writing-habit picker: a goal save whose confirming read crossed
 *   the renewal closed its editor and never made the link.
 * - The writing timer's linked-habit check-off: the minutes were logged on the
 *   server and the writer was never told.
 * - The Return offer: a "Begin" opened the arc on the server, and the offer
 *   stayed on screen with no let-go moment.
 *
 * Each case refuses one request's first attempt 401 at the browser's edge.
 * Everything after that is real: the production client refreshes the token
 * against the live server (which rotates it and revokes the old one) and
 * resends the request once with the renewed bearer, held briefly as a network
 * round trip would be, so the renewed credential has rendered before its
 * answer lands. All three now fence on the session lineage (`useAuthLineage`).
 * The proactive renewal, and the boundaries that must still refuse held work
 * (the same account signing back in after a 401, another account, A to B to
 * A, sign-out, and a 401 that lands before anything has rendered), are pinned
 * through the real AuthProvider in the `*Lineage.integration.test.tsx` suites
 * beside each surface.
 */

/** Long enough for the renewed credential to render before the resent request's answer. */
const ROUND_TRIP_MS = 750;
/** Long enough that a third attempt, had one been sent, would have been seen. */
const QUIET_MS = 500;
const MINUTE_MS = 60_000;
const SESSION_MINUTES = 20;
/** Long enough ago that the quiet foundation names a contraction (the window is 14 days). */
const QUIET_FOUNDATION_DAYS = 30;

const OK = 200;
const CREATED = 201;
const UNAUTHORIZED = 401;
const RETURN_OFFER_TITLE = 'The Return is open to you';
const ARTIFACTS = join(__dirname, 'artifacts', 'session-lineage-renewal');

interface Refused {
  /** Every attempt, in order, as the request the app sent. */
  attempts: Request[];
  /** The token the live server minted when the client renewed after the 401. */
  renewed: Promise<string>;
}

/**
 * Refuse the first `method` request to `pathname` 401 at the browser's edge and
 * let every later one reach the server after a round trip.
 */
async function refuseFirstOnce(page: Page, method: string, pathname: string): Promise<Refused> {
  const attempts: Request[] = [];
  const renewed = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/auth/refresh',
    )
    .then(async (response) => {
      expect(response.status()).toBe(OK);
      return ((await response.json()) as { token: string }).token;
    });
  const answer = async (route: Route): Promise<void> => {
    attempts.push(route.request());
    if (attempts.length === 1) {
      await route.fulfill({
        status: UNAUTHORIZED,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'unauthorized' }),
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_MS));
      await route.continue();
    }
  };
  await page.route(
    (url) => url.pathname === pathname,
    (route) => (route.request().method() === method ? answer(route) : route.fallback()),
  );
  return { attempts, renewed };
}

/** The refused attempt was resent exactly once, under the token the server renewed. */
async function expectRetriedUnderRenewal(page: Page, refused: Refused): Promise<void> {
  const renewed = await refused.renewed;
  await expect.poll(() => refused.attempts.length).toBe(2);
  const [first, retry] = refused.attempts;
  expect(retry?.headers().authorization).toBe(`Bearer ${renewed}`);
  expect(first?.headers().authorization).not.toBe(`Bearer ${renewed}`);
  await page.waitForTimeout(QUIET_MS);
  expect(refused.attempts).toHaveLength(2);
}

/** Give a dropped answer time to show itself before the shot, so a stuck surface is caught. */
async function settleThenFrame(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(1000);
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), animations: 'disabled' });
}

async function linkedHabitId(page: Page, token: string): Promise<number | null> {
  const response = await page.request.get(`${backendUrl()}/ui-flags`, { headers: bearer(token) });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { writing_session_habit_id: number | null })
    .writing_session_habit_id;
}

async function loggedUnits(page: Page, token: string, habitId: number): Promise<number> {
  const response = await page.request.get(`${backendUrl()}/habits/${String(habitId)}`, {
    headers: bearer(token),
  });
  expect(response.ok()).toBe(true);
  const habit = (await response.json()) as {
    goals: { completions?: { completed_units: number | null }[] }[];
  };
  return habit.goals
    .flatMap((goal) => goal.completions ?? [])
    .reduce((sum, row) => sum + (row.completed_units ?? 0), 0);
}

/**
 * The Journal shelf the person is looking at: closing an entry can leave an
 * earlier shelf mounted behind the visible one, each with its own Return
 * surface.
 */
function shown(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

/** Carry a fresh account to the Return offer on its Journal shelf, honestly. */
async function reachReturnOffer(page: Page, prefix: string): Promise<string> {
  const email = await signUp(page, prefix);
  const token = await tokenFor(page.request, email);
  await reachReturnEligibility(page.request, token, email);
  const habit = await page.request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name: 'Evening stillness',
      icon: '★',
      start_date: isoDaysAgo(QUIET_FOUNDATION_DAYS),
      energy_cost: 2,
      energy_return: 4,
      revealed: true,
    },
  });
  expect(habit.status()).toBe(OK);
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: {
      title: 'A quiet fortnight',
      message: 'The willow bent all night and did not break. I slept badly and woke grateful.',
    },
  });
  expect(created.status()).toBe(CREATED);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(OK);
  await page.goto(`${frontendUrl()}/journal`);
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await askForResonance(page);
  await expect(page.getByTestId('contraction-reflection-title')).toHaveText(RETURN_OFFER_TITLE);
  await page.getByTestId('journal-close-entry').click();
  await expect(shown(page, 'return-offer-accept')).toBeVisible();
  return token;
}

for (const width of [390, 1280]) {
  test(`a writing-habit goal save whose confirming read crosses a renewal links the habit at ${String(width)}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, `picker-renewal-${width}`);
    const token = await tokenFor(page.request, email);
    // Its goals count pages, so the picker offers to set it up before linking.
    const habitId = await seedHabit(page.request, token, 'Pages before noon', '2026-01-01', true);
    await page.reload();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByTestId('settings-row-writing-habit').click();
    await page.getByTestId(`writing-habit-configure-${String(habitId)}`).click();
    await expect(page.getByTestId('writing-habit-goals')).toBeVisible();
    const refused = await refuseFirstOnce(page, 'GET', '/habits/');

    await page.getByTestId('writing-habit-goals-save').click();
    await expectRetriedUnderRenewal(page, refused);
    await settleThenFrame(page, `picker-${String(width)}`);

    await expect(page.getByTestId('writing-habit-goals')).toHaveCount(0);
    await expect(page.getByTestId('settings-row-writing-habit')).toHaveAccessibleName(
      'Writing timer → Pages before noon',
    );
    expect(await linkedHabitId(page, token)).toBe(habitId);
  });

  test(`a writing session's check-in that crosses a renewal is logged and reported at ${String(width)}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    // Simulated sessions stay on one UTC day even when CI starts near midnight.
    const midday = new Date();
    midday.setUTCHours(12, 0, 0, 0);
    await page.clock.install({ time: midday });
    const email = await signUp(page, `checkoff-renewal-${width}`);
    const token = await tokenFor(page.request, email);
    const habitId = await seedTimerHabit(page.request, token, 'Morning pages');
    const linked = await page.request.patch(`${backendUrl()}/ui-flags`, {
      headers: bearer(token),
      data: { writing_session_habit_id: habitId },
    });
    expect(linked.ok()).toBe(true);
    // Observe the hydrated link before the timer jumps the page clock.
    await page.reload();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await expect(page.getByTestId('settings-row-writing-habit')).toHaveAccessibleName(
      'Writing timer → Morning pages',
    );
    await page.goBack();
    await page.getByTestId('journal-new-entry').click();
    await page.getByTestId('journal-body-input').fill('The kettle, the window, and a page.');
    const folded = page.getByTestId('writing-timer-compact');
    if (await folded.isVisible()) await folded.click();
    await page.getByTestId(`writing-timer-preset-${String(SESSION_MINUTES)}`).click();
    const refused = await refuseFirstOnce(page, 'POST', '/goal_completions/');

    await page.getByTestId('writing-timer-start').click();
    await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
    await page.clock.fastForward(SESSION_MINUTES * MINUTE_MS + 100);
    await expectRetriedUnderRenewal(page, refused);
    await page.getByTestId('writing-session-banner').scrollIntoViewIfNeeded();
    await settleThenFrame(page, `checkoff-${String(width)}`);

    await expect(page.getByTestId('writing-session-log-notice')).toHaveText(
      'Logged 20 minutes to Morning pages',
    );
    expect(await loggedUnits(page, token, habitId)).toBe(SESSION_MINUTES);
  });

  test(`a Return Begin that crosses a renewal opens the arc and its let-go moment at ${String(width)}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    const token = await reachReturnOffer(page, `return-begin-renewal-${width}`);
    const refused = await refuseFirstOnce(page, 'POST', '/metta-return/arc');

    await shown(page, 'return-offer-accept').click();
    await expectRetriedUnderRenewal(page, refused);
    await settleThenFrame(page, `return-begin-${String(width)}`);

    await expect(shown(page, 'return-letgo-card')).toBeVisible();
    await expect(shown(page, 'return-offer-accept')).toHaveCount(0);
    expect((await readReturnState(page.request, token)).arc).not.toBeNull();
  });
}
