import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import type { ApiProgressOverview } from '../src/api';

import { backendUrl, bearer, isoDaysAgo, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Issue #3528 — the Map's "Your progress" door opens the whole arc, drawn from
 * what the server computed (#3522).
 *
 * The seam: an account whose program anchor sits twenty-two weeks back, and a
 * month of real check-ins through `POST /goal_completions/`, become
 * `GET /progress/overview`, which the Progress screen reached from the Map's
 * drawer turns into the ribbon's you-are-here line, the rhythm and the energy
 * ledger with its formula printed beside it. The anchor is moved through the
 * real `PUT /stages/program-calendar`, which carries the live pass with it, so
 * the arc and its one pass ribbon (#3727) measure from the same day.
 *
 * A second journey re-scaffolds through `POST /stages/passes` and reads two
 * stacked pass ribbons, each with its own numbered habit markers.
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

/** Start the first cycle `daysAgo` days back through the real route; the live pass moves too. */
async function startProgramDaysAgo(
  request: APIRequestContext,
  token: string,
  daysAgo: number,
): Promise<void> {
  const moved = await request.put(`${backendUrl()}/stages/program-calendar`, {
    headers: bearer(token),
    data: { program_start_date: isoDaysAgo(daysAgo) },
  });
  expect(moved.ok(), `moving the program start failed: ${await moved.text()}`).toBe(true);
}

/** A revealed habit with one goal, so its unlock is logged in the pass running now. */
async function seedUnlockedHabit(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<void> {
  const created = await request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name,
      icon: '•',
      energy_cost: 1,
      energy_return: 1,
      stage: '0',
      start_date: isoDaysAgo(0),
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
  expect(created.ok(), `seeding ${name} failed: ${await created.text()}`).toBe(true);
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
    .getByRole('button', { name: 'Stats and progress', exact: true })
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

/** Each habit's line on Progress opens its Story, where the heat map lives (D06). */
async function openStoryFromProgress(page: Page, screenshot: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  const journal = page
    .getByTestId('progress-screen')
    .locator('[data-testid^="progress-habit-"]')
    .filter({ has: page.getByText(HABIT, { exact: true }) })
    .first();
  await journal.scrollIntoViewIfNeeded();
  const read = page.waitForResponse((response) =>
    /^\/habits\/\d+\/story$/.test(new URL(response.url()).pathname),
  );
  await journal.getByRole('button', { name: 'Story', exact: true }).click();
  expect((await read).status()).toBe(200);
  const sheet = page.getByTestId('habit-story-sheet');
  await expect(sheet).toContainText(HABIT);
  await expect(sheet.getByTestId('habit-story-heat-grid')).toBeVisible();
  await page.screenshot({ path: screenshot });
  await page.getByRole('button', { name: 'Close story' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('progress-screen')).toBeVisible();
}

function verifyServedHistories(overview: ApiProgressOverview): void {
  const journalBirth = overview.arc.habit_births.find((birth) => birth.name === HABIT);
  expect(journalBirth).toMatchObject({ is_carryover: false, week: 1, stage_number: 1 });
  expect(journalBirth?.unit_histories?.[0]?.days.at(-1)?.units).toBe(MINUTES_PER_DAY);
  // Dated week three, it joins when Purple opens in week four (adoption, not template start dates).
  expect(overview.arc.habit_births.find((birth) => birth.name === PURPLE_HABIT)).toMatchObject({
    week: 4,
    stage_number: 2,
  });
  const today = overview.rhythm.days.at(-1)!;
  expect(today.window_days).toBe(7);
  expect(today.rate).toBeCloseTo(today.window_met / today.window_scheduled, 10);
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
      start_date: isoDaysAgo(ANCHOR_DAYS_AGO - 14),
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
  // A habit with nothing logged has no line to draw; one check-in gives it one.
  const purpleGoal = ((await purple.json()) as { goals: Array<{ id: number }> }).goals[0]?.id;
  const sat = await page.request.post(`${backendUrl()}/goal_completions/`, {
    headers: bearer(token),
    data: { goal_id: purpleGoal, completed_units: 5 },
  });
  expect(sat.ok(), await sat.text()).toBe(true);
  await startProgramDaysAgo(page.request, token, ANCHOR_DAYS_AGO);
  await page.reload();

  const overview = await openProgressFromMap(page);
  verifyServedHistories(overview);
  const screen = page.getByTestId('progress-screen');
  // One pass and none pending: a single row, not labelled "Pass 1" (#3727).
  expect(overview.arc.passes).toHaveLength(1);
  await expect(screen.getByTestId('progress-pass-1')).toContainText(
    new RegExp(`Week ${CURRENT_WEEK} · \\w+`),
  );
  await expect(screen.getByTestId('progress-pass-1')).not.toContainText('Pass 1');
  await expect(screen.getByTestId('progress-energy')).toContainText(
    'Energy returned minus effort spent, by week',
  );
  await expect(screen).not.toContainText(/sum\(return - cost\)|Hover or tap|Units logged/);
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
    await expect(journal.locator('[data-testid$="-value"]')).toContainText('20 logged that day');
    const wave = screen.getByTestId('progress-wave-inspect');
    await wave.scrollIntoViewIfNeeded();
    const waveBounds = await wave.boundingBox();
    await wave.hover({ position: { x: waveBounds!.width - 8, y: waveBounds!.height / 2 } });
    const hoverValue = await screen.getByTestId('progress-wave-value').textContent();
    const last = overview.rhythm.days.at(-1)!;
    expect(hoverValue).toContain(
      `· ${Math.round(last.rate * 100)}% · ${last.window_met} of ${last.window_scheduled} kept`,
    );
    await inspectEnd(page, wave);
    await expect(screen.getByTestId('progress-wave-value')).toContainText(' kept');
    await screen.getByTestId('progress-wave-inspect').press('Home');
    await expect(screen.getByTestId('progress-wave-value')).toContainText(' · 0% · 0 of ');
    for (const id of ['progress-pass-1', 'progress-wave', 'progress-energy-columns']) {
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
    const ribbon = screen.getByTestId('progress-pass-1');
    await ribbon.getByRole('button', { name: 'Show as table' }).click();
    await expect(ribbon).toContainText('Weeks 1–3');
    await expect(ribbon).toContainText('Weeks 4–6');
    await expect(ribbon).toContainText('Weeks 31–36');
    // Habits seeded before the account had a pass log no pass, so this row may
    // carry no markers; any it does carry are listed with their numbers.
    for (const marker of overview.arc.passes![0]!.markers)
      await expect(ribbon).toContainText(`Habit ${marker.program_number} · ${marker.name}`);
    await expect(ribbon).toContainText('You are here');
    await expect(ribbon).toContainText(`Week ${CURRENT_WEEK}`);
    await expect(ribbon).not.toContainText('Weeks / week');
    await screen.evaluate((element) => element.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`map-progress-table-${viewport.name}.png`) });
    await scrollToEnergy(page, viewport);
    await ribbon.getByRole('button', { name: 'Show chart' }).click();
  }

  await openStoryFromProgress(page, testInfo.outputPath('map-progress-story-phone.png'));
});

/** Issue #3727: a re-scaffold leaves the old pass as its own ribbon above the new one. */
const FIRST_PASS_DAYS_AGO = 100;
/** The held pass begins this many days ahead, so it is drawn as pending. */
const PENDING_IN_DAYS = 12;
const FIRST_HABIT = 'Breathwork';
const SECOND_HABIT = 'Night reading';
const THIRD_HABIT = 'Cold water';

type Pass = NonNullable<ApiProgressOverview['arc']['passes']>[number];
type Marker = Pass['markers'][number];

const spoken = (marker: Marker): string =>
  `Habit ${marker.program_number} · ${marker.name} · unlocked `;

/** Open a pass on `daysAgo` (negative: ahead) through the real route. */
async function openPass(request: APIRequestContext, token: string, daysAgo: number) {
  const opened = await request.post(`${backendUrl()}/stages/passes`, {
    headers: bearer(token),
    data: { start_day: isoDaysAgo(daysAgo) },
  });
  expect(opened.status(), await opened.text()).toBe(201);
}

/** The badge's centre on the page: where a pointer or a finger would land on it. */
async function badgeCentre(row: Locator, index: number): Promise<{ x: number; y: number }> {
  const badge = row.getByTestId(`ribbon-marker-${index}`);
  await badge.scrollIntoViewIfNeeded();
  const box = await badge.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** Hover, touch and keys each reach the live row's markers and read them out. */
async function inspectMarkers(page: Page, row: Locator, markers: readonly Marker[]) {
  const value = row.locator('[data-testid$="-value"]');
  const plot = row.locator('[data-testid$="-inspect"]');
  const last = markers.length - 1;
  // Hover the last badge, then the first.
  for (const index of [last, 0]) {
    const centre = await badgeCentre(row, index);
    await page.mouse.move(centre.x, centre.y);
    await expect(value).toContainText(spoken(markers[index]!));
  }
  // Move the selection away by keyboard, then a tap on the first badge brings it back.
  await plot.press('End');
  await expect(value).toContainText(spoken(markers[last]!));
  const first = await badgeCentre(row, 0);
  await page.touchscreen.tap(first.x, first.y);
  await expect(value).toContainText(spoken(markers[0]!));
  // Keys: Home, ArrowRight, End, and ArrowRight held at the end.
  await plot.press('Home');
  await expect(value).toContainText(spoken(markers[0]!));
  await plot.press('ArrowRight');
  await expect(value).toContainText(spoken(markers[Math.min(1, last)]!));
  await plot.press('End');
  await expect(value).toContainText(spoken(markers[last]!));
  await plot.press('ArrowRight');
  await expect(value).toContainText(spoken(markers[last]!));
}

/** An ended pass stops where it got to; a pending one is the bare, dashed track. */
async function verifyExtents(older: Locator, pending: Locator) {
  await expect(older).toContainText(/reached stage \d+, week \d+/);
  await expect(older.getByTestId('ribbon-track')).toHaveAttribute('stroke-dasharray', /4[ ,]+4/);
  await expect(pending).toContainText(/Pass \d+ · begins \d{1,2} \w+/);
  await expect(pending.getByTestId('ribbon-track')).toHaveAttribute('stroke-dasharray', /4[ ,]+4/);
  await expect(pending.locator('[data-testid^="ribbon-block-"]')).toHaveCount(0);
  await expect(pending.locator('[data-testid^="ribbon-marker-"]')).toHaveCount(0);
}

test('a re-scaffold stacks one numbered ribbon per pass, oldest on top', async ({
  page,
}, testInfo) => {
  const email = await signUp(page, 'map-passes');
  const token = await tokenFor(page.request, email);
  await startProgramDaysAgo(page.request, token, FIRST_PASS_DAYS_AGO);
  await seedUnlockedHabit(page.request, token, FIRST_HABIT);
  await openPass(page.request, token, 0);
  await seedUnlockedHabit(page.request, token, SECOND_HABIT);
  await seedUnlockedHabit(page.request, token, THIRD_HABIT);
  await openPass(page.request, token, -PENDING_IN_DAYS);
  await page.reload();

  const overview = await openProgressFromMap(page);
  const passes = overview.arc.passes ?? [];
  expect(passes.map((pass) => pass.state)).toEqual(['ended', 'live', 'pending']);
  const [first, second, held] = passes as [Pass, Pass, Pass];
  expect(first.markers.map((marker) => marker.name)).toContain(FIRST_HABIT);
  expect(second.markers.map((marker) => marker.name)).toEqual(
    expect.arrayContaining([SECOND_HABIT, THIRD_HABIT]),
  );
  expect(held.markers).toEqual([]);

  const screen = page.getByTestId('progress-screen');
  const older = screen.getByTestId(`progress-pass-${first.pass_number}`);
  const live = screen.getByTestId(`progress-pass-${second.pass_number}`);
  const pending = screen.getByTestId(`progress-pass-${held.pass_number}`);
  await expect(older).toContainText(`Pass ${first.pass_number} · began`);
  await expect(live).toContainText(`Pass ${second.pass_number} · began`);
  await expect(live).toContainText('in progress — week 1, until ');
  await verifyExtents(older, pending);
  const tops = await Promise.all(
    [older, live, pending].map(async (row) => (await row.boundingBox())!.y),
  );
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await screen.evaluate((element) => element.scrollTo(0, 0));
    for (const [row, pass] of [
      [older, first],
      [live, second],
    ] as const) {
      const marker = pass.markers[0]!;
      // Each badge carries its program number as text, not colour alone.
      await expect(row.locator('svg text').first()).toHaveText(String(marker.program_number));
      // Keyboard reaches the first marker and reads it out.
      await row.locator('[data-testid$="-inspect"]').press('Home');
      await expect(row.locator('[data-testid$="-value"]')).toContainText(spoken(marker));
    }
    await inspectMarkers(page, live, second.markers);
    for (const row of [older, live, pending]) {
      const bounds = await row.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    }
    await page.screenshot({ path: testInfo.outputPath(`map-passes-${viewport.name}.png`) });
  }

  // The table twin lists each habit with its unlock day and week.
  await live.getByRole('button', { name: 'Show as table' }).click();
  const newest = second.markers.find((marker) => marker.name === SECOND_HABIT)!;
  await expect(live).toContainText(`Habit ${newest.program_number} · ${SECOND_HABIT}`);
  await expect(live).toContainText(`Week ${newest.week}`);
  await expect(live).toContainText('Unlocked ');
});
