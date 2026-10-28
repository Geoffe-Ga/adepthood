import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import type { ApiProgressOverview } from '../src/api';

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

test.use({ hasTouch: true });

const HABIT = 'Journaling';
const PURPLE_HABIT = 'Frequency practice';
/** Twenty-two weeks back puts today in week 23 of the arc. */
const ANCHOR_DAYS_AGO = 22 * 7;
const CURRENT_WEEK = 23;
/** The backfill window allows thirty days; every other day rests. */
const LOGGED_SPAN_DAYS = 30;
const MINUTES_PER_DAY = 20;
const VIEWPORTS = [
  { name: 'small-phone', width: 320, height: 568 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 720 },
] as const;

async function seedWalks(request: APIRequestContext, token: string): Promise<void> {
  const created = await request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name: HABIT,
      icon: '🚶',
      energy_cost: 5,
      energy_return: 2,
      stage: '0',
      start_date: isoDaysAgo(ANCHOR_DAYS_AGO + 1),
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

async function openProgressFromMap(page: Page): Promise<ApiProgressOverview> {
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
  const response = await read;
  expect(response.status()).toBe(200);
  return (await response.json()) as ApiProgressOverview;
}

async function scrollToEnergy(page: Page, viewport: { width: number; height: number }) {
  const energyControl = page
    .getByTestId('progress-energy-columns')
    .getByRole('button', { name: 'Show as table' });
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  // Wheel input is asynchronous. Keep paging as a person would until the final
  // control reaches the viewport, rather than racing one huge wheel event.
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, viewport.height);
      return energyControl.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
      });
    })
    .toBe(true);
  await expect(energyControl).toBeInViewport();
}

async function inspectEnd(page: Page, plot: Locator): Promise<void> {
  await plot.scrollIntoViewIfNeeded();
  const bounds = await plot.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width - 8;
  const y = bounds!.y + bounds!.height / 2;
  await page.mouse.move(x, y);
  await page.touchscreen.tap(x, y);
}

function verifyServedHistories(overview: ApiProgressOverview): void {
  const journalBirth = overview.arc.habit_births.find((birth) => birth.name === HABIT);
  expect(journalBirth).toMatchObject({ is_carryover: false, week: 1, stage_number: 1 });
  expect(journalBirth?.unit_histories?.[0]?.days.at(-1)?.units).toBe(MINUTES_PER_DAY);
  expect(overview.arc.habit_births.find((birth) => birth.name === PURPLE_HABIT)?.stage_number).toBe(
    2,
  );
}

test('the Map door opens the arc, rhythm and energy ledger the server computed', async ({
  page,
}, testInfo) => {
  const email = await signUp(page, 'map-progress');
  const token = await tokenFor(page.request, email);
  await seedWalks(page.request, token);
  const purple = await page.request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name: PURPLE_HABIT,
      icon: '🧘',
      energy_cost: 0,
      energy_return: 0,
      stage: 'Purple',
      start_date: isoDaysAgo(ANCHOR_DAYS_AGO - 21),
      revealed: true,
      goals: {
        target_unit: 'minutes',
        frequency: 1,
        frequency_unit: 'per_day',
        low: 1,
        clear: 5,
        stretch: 10,
      },
    },
  });
  expect(purple.ok(), await purple.text()).toBe(true);
  setProgramAnchorDaysAgo(email, ANCHOR_DAYS_AGO);
  await page.reload();

  const overview = await openProgressFromMap(page);
  verifyServedHistories(overview);
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
    await screen.evaluate((element) => element.scrollTo(0, 0));
    await expect(screen.getByTestId('ribbon-stage-key')).toHaveCount(0);
    await expect(screen.getByTestId('ribbon-birth-key')).toHaveCount(0);
    await expect(screen.getByTestId('progress-arc')).not.toContainText('Brought with you');
    const habitRows = screen
      .locator('[data-testid^="progress-habit-"]')
      .filter({ has: page.locator('[data-testid="history-line"]') });
    expect(await habitRows.count()).toBeGreaterThan(0);
    await expect(screen.getByText(HABIT, { exact: true })).toBeVisible();
    const journal = screen
      .locator('[data-testid^="progress-habit-"]')
      .filter({ has: page.getByText(HABIT, { exact: true }) })
      .first();
    await expect(journal.getByTestId('history-line')).toHaveAttribute('stroke', '#d8cbb8');
    const purple = screen
      .locator('[data-testid^="progress-habit-"]')
      .filter({ has: page.getByText(PURPLE_HABIT, { exact: true }) })
      .first();
    await expect(purple.getByTestId('history-line')).toHaveAttribute('stroke', '#a093c6');
    await inspectEnd(page, journal.locator('[data-testid$="-inspect"]'));
    await expect(journal.locator('[data-testid$="-value"]')).toContainText('20 minutes logged');
    const wave = screen.getByTestId('progress-wave-inspect');
    await wave.scrollIntoViewIfNeeded();
    const waveBounds = await wave.boundingBox();
    await wave.hover({ position: { x: waveBounds!.width - 8, y: waveBounds!.height / 2 } });
    const hoverValue = await screen.getByTestId('progress-wave-value').textContent();
    const percentage = Number(/· ([\d.,]+)/.exec(hoverValue ?? '')?.[1]?.replaceAll(',', ''));
    expect(percentage).toBeCloseTo(overview.rhythm.days.at(-1)!.rate * 100, 5);
    await inspectEnd(page, wave);
    await expect(screen.getByTestId('progress-wave-value')).toContainText('14-day average');
    await screen.getByTestId('progress-wave-inspect').press('Home');
    await expect(screen.getByTestId('progress-wave-value')).toContainText(
      '0 scheduled activities completed (%)',
    );
    for (const id of ['progress-ribbon', 'progress-wave', 'progress-energy-columns']) {
      const bounds = await screen.getByTestId(id).boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    }
    await page.screenshot({ path: testInfo.outputPath(`map-progress-${viewport.name}.png`) });

    await scrollToEnergy(page, viewport);
    await expect.poll(() => screen.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await inspectEnd(page, screen.getByTestId('progress-energy-columns-inspect'));
    await expect(screen.getByTestId('progress-energy-columns-value')).toContainText(/· -\d+/);
    await page.screenshot({
      path: testInfo.outputPath(`map-progress-energy-${viewport.name}.png`),
    });

    await screen.evaluate((element) => element.scrollTo(0, 0));
    const ribbon = screen.getByTestId('progress-ribbon');
    await ribbon.getByRole('button', { name: 'Show as table' }).click();
    await expect(ribbon).toContainText('Weeks 1–3');
    await expect(ribbon).toContainText('Weeks 4–6');
    await expect(ribbon).toContainText('Weeks 31–36');
    await expect(ribbon).toContainText(`${HABIT} began`);
    await expect(ribbon).toContainText('Week 1');
    await expect(ribbon).toContainText('You are here');
    await expect(ribbon).toContainText(`Week ${CURRENT_WEEK}`);
    await expect(ribbon).not.toContainText('Weeks / week');
    await screen.evaluate((element) => element.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`map-progress-table-${viewport.name}.png`) });
    await scrollToEnergy(page, viewport);
    await ribbon.getByRole('button', { name: 'Show chart' }).click();
  }
});
