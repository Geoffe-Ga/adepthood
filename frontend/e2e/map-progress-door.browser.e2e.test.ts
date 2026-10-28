import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  backendUrl,
  bearer,
  isoDaysAgo,
  setProgramAnchorDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * Issue #3528 — the Map's "Your progress" door opens the whole arc, drawn from
 * what the server computed (#3522).
 *
 * The seam: an account whose program anchor sits twenty-two weeks back, and a
 * month of real check-ins through `POST /goal_completions/`, become
 * `GET /progress/overview`, which the Progress screen reached from the Map's
 * drawer turns into the ribbon's you-are-here line, the rhythm and the energy
 * ledger with its formula printed beside it. The anchor is the one out-of-band
 * arrange: no request schema moves `program_started_at`.
 */

const HABIT = 'Evening walk';
/** Twenty-two weeks back puts today in week 23 of the arc. */
const ANCHOR_DAYS_AGO = 22 * 7;
const CURRENT_WEEK = 23;
/** The backfill window allows thirty days; every other day rests. */
const LOGGED_SPAN_DAYS = 30;
const MINUTES_PER_DAY = 20;
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone-full', width: 390, height: 2600 },
  { name: 'desktop-full', width: 1280, height: 2000 },
] as const;

async function seedWalks(request: APIRequestContext, token: string): Promise<void> {
  const created = await request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name: HABIT,
      icon: '🚶',
      energy_cost: 2,
      energy_return: 5,
      start_date: isoDaysAgo(LOGGED_SPAN_DAYS + 10),
      revealed: true,
      goals: {
        target_unit: 'minutes',
        frequency: 1,
        frequency_unit: 'per_day',
        low: 10,
        clear: 20,
        stretch: 45,
      },
    },
  });
  expect(created.ok(), `seeding the habit failed: ${await created.text()}`).toBe(true);
  const goalId = ((await created.json()) as { goals: Array<{ id: number }> }).goals[0]?.id;
  for (let daysAgo = LOGGED_SPAN_DAYS - 1; daysAgo >= 0; daysAgo -= 1) {
    if (daysAgo % 3 === 1) continue;
    const logged = await request.post(`${backendUrl()}/goal_completions/`, {
      headers: bearer(token),
      data: {
        goal_id: goalId,
        completed_units: MINUTES_PER_DAY,
        ...(daysAgo === 0 ? {} : { completed_on: isoDaysAgo(daysAgo) }),
      },
    });
    expect(logged.ok(), `logging ${daysAgo} days ago failed: ${await logged.text()}`).toBe(true);
  }
}

async function openProgressFromMap(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Open \w+ menu$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Open Map menu' }).click();
  const read = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/progress/overview',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Your progress', exact: true })
    .click();
  expect((await read).status()).toBe(200);
}

test('the Map door opens the arc, rhythm and energy ledger the server computed', async ({
  page,
}, testInfo) => {
  const email = await signUp(page, 'map-progress');
  await seedWalks(page.request, await tokenFor(page.request, email));
  setProgramAnchorDaysAgo(email, ANCHOR_DAYS_AGO);
  await page.reload();

  await openProgressFromMap(page);
  const screen = page.getByTestId('progress-screen');
  await expect(screen.getByTestId('progress-here')).toHaveText(
    new RegExp(`^Week ${CURRENT_WEEK} · \\w+`),
  );
  await expect(screen.getByTestId('progress-ribbon')).toBeVisible();
  await expect(screen.getByTestId('progress-energy-formula')).toHaveText(
    'sum(return - cost) over completions',
  );
  await expect(screen.getByTestId('progress-energy-columns')).toBeVisible();
  await expect(screen).not.toContainText(/streak|broken|missed|lost|failed/i);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.screenshot({ path: testInfo.outputPath(`map-progress-${viewport.name}.png`) });
  }
});
