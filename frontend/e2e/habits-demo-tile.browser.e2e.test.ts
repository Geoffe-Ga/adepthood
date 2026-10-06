import type { ChildProcess } from 'node:child_process';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { STATS_CLOSE_LABEL } from '../src/features/Habits/components/modalCloseLabels';
import { HABIT_DEFAULTS } from '../src/features/Habits/HabitDefaults';

import { BOOT_TIMEOUT_MS, launchFrontend, waitForFrontend } from './browserGlobalSetup';
import { stopProcessGroup } from './browserGlobalTeardown';
import {
  DEMO_SEED_TOAST,
  HABITS_CACHE_PREFIX,
  HABITS_UNREACHABLE,
  LOADING_STATS,
  SYNC_FAILURE_TITLE,
  forbiddenDemoRequests,
  isHabitsListGet,
  type RecordedRequest,
} from './demoTileBrowserSupport';
import { DEMO_FRONTEND_PORT, HABIT_DEMO_ENV } from './frontendEnv';
import { backendUrl, openHabits, signUp } from './journalHabitsBrowserSupport';

/**
 * Issue #2491 — a demo placeholder tile stays local: nothing done to it puts
 * its fabricated id on the wire.
 *
 * The demo tiles exist only in a build made with `EXPO_PUBLIC_HABIT_DEMO_MODE`
 * (#2671), and only while the habit list cannot be fetched and nothing is
 * cached. Their ids are 1..10 -- numbers that are also the ids of whatever real
 * rows a user owns -- so a demo tile that reached the wire could rename, or
 * delete, somebody's real habit 3. The guards that stop that are unit-tested
 * against a mocked client; this proves them against a real one.
 *
 * Reaching the state honestly takes three things the shared lane does not have:
 *
 *  - A demo bundle. The flag is inlined when Expo builds the bundle, so it
 *    cannot be flipped for one spec on the lane's own server without changing
 *    the app for every other spec. This spec boots its own Expo web server on
 *    `DEMO_FRONTEND_PORT` -- the other port the backend's development CORS
 *    already allows -- and stops it afterwards. The lane guard confines that to
 *    this one file.
 *  - A failing habit list. `page.route` aborts exactly `GET /habits/` on the
 *    API origin, from the harness and never from the app. Every other request,
 *    the account's real sign-up and log-in among them, reaches the real server.
 *  - No habit cache. The on-device cache would otherwise stand in for the
 *    server, so its keys are cleared before the page that is measured loads.
 *
 * The proof is the request log. React Native Web's `Alert.alert` is a no-op, so
 * a "Couldn't sync" alert could never be SEEN here even if one were raised;
 * what makes its absence meaningful is that such an alert is only raised from
 * the catch of a wire call, and the log shows no such call was made. The
 * on-screen and dialog checks are kept as the secondary witnesses they are.
 *
 * What this pins about edits is CURRENT behaviour, not a decision: edits to a
 * demo tile apply in memory and are gone after a reload, because demo rows are
 * never written to the cache. Whether they should be adoptable instead is #2465,
 * still open; this spec takes no side on it.
 *
 * One action the ledger lists has no reachable control on web: the habit
 * settings' start-date picker renders nothing there, and the missed-days
 * modal that offers "set a new start date" (and its chained check-in clear) is
 * never opened by anything. The start date is reset instead through the one web
 * control that sets it, the reorder modal's "First habit start date".
 */

const DEMO_ORIGIN = `http://127.0.0.1:${DEMO_FRONTEND_PORT}`;
/** Every tile the demo seeds, by name: the whole set, not a count. */
const DEMO_NAMES = HABIT_DEFAULTS.map((habit) => habit.name);
/** A whole journey of local actions on a cold bundle; the lane default is 60s. */
const JOURNEY_TIMEOUT_MS = 180_000;

const RENAMED_TILE = 'Meditation';
const NEW_NAME = 'A name only this device knows';
const ICON_TILE = 'Exercise';
const NEW_ICON = '🤩';
const GOAL_TILE = 'Food Choices';
const NEW_LOW_TARGET = '4';
const NEW_UNIT = 'minutes';
const LOGGED_TILE = 'Sangha';
/** What a met tile says; the logged sample tile is not met until the unit lands. */
const ACHIEVED_TODAY = 'ACHIEVED TODAY';
/** Every success toast a real check-in raises: a milestone, or a plain log. */
const MILESTONE_OR_LOGGED = new RegExp(`(?:achieved|Logged \\d+) for ${LOGGED_TILE}`, 'u');
const STATS_TILE = 'Scrolling';
const DELETED_TILE = 'Limit Caffeine';
/** Any past day the first habit's start date can be moved to. */
const NEW_START_DATE = '2026-01-05';
/** The stats sheet's totals line, drawn once there are stats to draw. */
const STATS_CONTENT = 'Total Completions:';

/** How long the habit list must go unasked before the journey acts. */
const LIST_READS_QUIET_MS = 1500;
const LIST_READS_SETTLE_TIMEOUT_MS = 30_000;
/** A point on the goal sheet's backdrop that the sheet never covers. */
const BACKDROP_CORNER = { x: 4, y: 4 };

let demoServer: ChildProcess | null = null;

test.beforeAll(async () => {
  test.setTimeout(BOOT_TIMEOUT_MS);
  const child = launchFrontend(backendUrl(), DEMO_FRONTEND_PORT, HABIT_DEMO_ENV);
  demoServer = child;
  try {
    await waitForFrontend(child, DEMO_ORIGIN);
  } catch (error: unknown) {
    await stopProcessGroup(child.pid ?? 0);
    demoServer = null;
    throw error;
  }
});

test.afterAll(async () => {
  await stopProcessGroup(demoServer?.pid ?? 0);
  demoServer = null;
});

function tile(page: Page, name: string): Locator {
  return page.getByTestId('habit-tile').filter({ hasText: name });
}

/** Pick a drawer item, once any drawer still closing from the last pick has gone. */
async function fromMenu(page: Page, item: string): Promise<void> {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Habits menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: item, exact: true }).click();
}

async function exitMode(page: Page): Promise<void> {
  await page.getByTestId('exit-mode').click();
  await expect(page.getByTestId('exit-mode')).toHaveCount(0);
}

/** Open a tile's settings the way a user does: Edit mode, then the tile. */
async function openSettings(page: Page, name: string): Promise<Locator> {
  await fromMenu(page, 'Edit');
  await tile(page, name).click();
  const card = page.getByTestId('habit-settings-card');
  await expect(card).toBeVisible();
  return card;
}

/** Close the goal sheet by its backdrop, tapped clear of the sheet itself. */
async function closeGoalSheet(page: Page): Promise<void> {
  const backdrop = page.getByTestId('goal-modal-backdrop');
  await backdrop.click({ position: BACKDROP_CORNER });
  await expect(backdrop).toHaveCount(0);
}

/**
 * Wait until the app has stopped asking for the habit list.
 *
 * A cold start reads it several times (the journal's summary, the tab's own
 * load, the second load once the account's zone is known, and the client's
 * retries). Each read fails here, and a failed read on a store holding only
 * demo rows re-installs the demo seed from scratch (`handleApiError`), undoing
 * whatever was done to the tiles so far. Acting before the reads stop would
 * race that re-seed, so the journey starts once no read has been sent for a
 * quiet window.
 */
async function listReadsSettled(count: () => number): Promise<void> {
  let previous = -1;
  await expect
    .poll(
      () => {
        const now = count();
        const quiet = now > 0 && now === previous;
        previous = now;
        return quiet;
      },
      { intervals: [LIST_READS_QUIET_MS], timeout: LIST_READS_SETTLE_TIMEOUT_MS },
    )
    .toBe(true);
}

async function expectEveryDemoTile(page: Page): Promise<void> {
  for (const name of DEMO_NAMES) await expect(tile(page, name)).toBeVisible();
  await expect(page.getByTestId('habit-tile')).toHaveCount(DEMO_NAMES.length);
}

test('a demo placeholder tile stays local: no action puts its fabricated id on the wire', async ({
  page,
}) => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const api = backendUrl();
  const apiOrigin = new URL(api).origin;
  await signUp(page, 'demo-tile', DEMO_ORIGIN);

  const requests: RecordedRequest[] = [];
  page.on('request', (request) => requests.push({ method: request.method(), url: request.url() }));
  // Checked after every step as well as at the end, so a leak is named by the
  // step that caused it rather than by whatever its failed write broke later.
  const nothingSent = (step: string): void => {
    expect(forbiddenDemoRequests(requests, api), `${step} put a demo id on the wire`).toEqual([]);
  };
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  await page.route(
    (url) => url.origin === apiOrigin,
    async (route) => {
      const request = route.request();
      if (isHabitsListGet(request.method(), request.url(), api)) await route.abort('failed');
      else await route.continue();
    },
  );
  await page.evaluate((prefix) => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(prefix)) window.localStorage.removeItem(key);
    }
  }, HABITS_CACHE_PREFIX);
  await page.reload();
  await openHabits(page);
  await listReadsSettled(
    () => requests.filter(({ method, url }) => isHabitsListGet(method, url, api)).length,
  );

  // --- The demo seed: the error, and every sample tile beside it, unlocked. ---
  await expect(page.getByText(HABITS_UNREACHABLE)).toBeVisible();
  await expectEveryDemoTile(page);
  await expect(page.getByTestId('unlock-label')).toHaveCount(0);

  // --- Reveal, both ways: the seeded tiles start revealed. ---
  await fromMenu(page, 'Lock Unstarted Habits');
  await expect(page.getByTestId('unlock-label').first()).toBeVisible();
  await fromMenu(page, 'Unlock All Habits');
  const unlockAll = page.getByTestId('unlock-all-confirm');
  await expect(unlockAll).toBeVisible();
  await unlockAll.getByRole('button', { name: 'Unlock All', exact: true }).click();
  await expect(unlockAll).toHaveCount(0);
  await expect(page.getByTestId('unlock-label')).toHaveCount(0);

  nothingSent('reveal');

  // --- Reorder, and move the first habit's start date with it. ---
  const settings = await openSettings(page, RENAMED_TILE);
  await settings.getByTestId('habit-settings-reorder').click();
  await expect(page.getByTestId('reorder-modal-card')).toBeVisible();
  await page.getByLabel('First habit start date').fill(NEW_START_DATE);
  await page
    .getByRole('listitem', { name: new RegExp(`^Move ${DEMO_NAMES[0] ?? ''},`) })
    .dragTo(page.getByRole('listitem', { name: new RegExp(`^Move ${DEMO_NAMES[2] ?? ''},`) }));
  await page.getByRole('button', { name: 'Save Order' }).click();

  await expect(page.getByTestId('reorder-modal-card')).toBeHidden();

  nothingSent('reorder');

  // --- Rename through the tile's settings. ---
  const renaming = page.getByTestId('habit-settings-card');
  if (!(await renaming.isVisible())) await tile(page, RENAMED_TILE).click();
  await renaming.getByRole('textbox').first().fill(NEW_NAME);
  await renaming.getByTestId('habit-settings-save').click();
  await expect(tile(page, NEW_NAME)).toBeVisible();
  await exitMode(page);

  nothingSent('rename');

  // --- Icon, goal target and units, through the goal sheet. ---
  await tile(page, ICON_TILE).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Change habit icon' }).click();
  // Each emoji is a pressable with no role; the key is the one holding the glyph.
  await page
    .getByRole('dialog')
    .locator('[tabindex="0"]')
    .filter({ hasText: new RegExp(`^${NEW_ICON}$`, 'u') })
    .first()
    .click();
  await closeGoalSheet(page);
  await expect(tile(page, ICON_TILE)).toContainText(NEW_ICON);

  await tile(page, GOAL_TILE).click();
  await page.getByRole('button', { name: 'Edit habit goals' }).click();
  await page.getByTestId('goal-target-display-low').click();
  await page.getByTestId('goal-target-input-low').fill(NEW_LOW_TARGET);
  await page.getByTestId('goal-target-save-low').click();
  await page.getByTestId('goal-target-unit').getByRole('radio', { name: NEW_UNIT }).click();
  await closeGoalSheet(page);

  nothingSent('icon, goal and units');

  // --- Log a unit: the sample notice, and no milestone. ---
  await expect(tile(page, LOGGED_TILE)).not.toContainText(ACHIEVED_TODAY);
  await tile(page, LOGGED_TILE).click();
  await page.getByRole('button', { name: 'Log Units' }).click();
  await expect(page.getByText(DEMO_SEED_TOAST)).toBeVisible();
  await expect(page.getByText(MILESTONE_OR_LOGGED)).toHaveCount(0);
  await closeGoalSheet(page);
  // The check-in stays on the tile, locally: the sample is explorable.
  await expect(tile(page, LOGGED_TILE)).toContainText(ACHIEVED_TODAY);

  nothingSent('check-in');

  // --- Stats render locally rather than waiting on a read that never comes. ---
  await fromMenu(page, 'Stats');
  await tile(page, STATS_TILE).click();
  await expect(page.getByText(STATS_CONTENT)).toBeVisible();
  await expect(page.getByText(LOADING_STATS)).toHaveCount(0);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: STATS_CLOSE_LABEL, exact: true })
    .click();
  await expect(page.getByText(STATS_CONTENT)).toHaveCount(0);
  await exitMode(page);

  nothingSent('stats');

  // --- Delete: the destructive one. ---
  const deleting = await openSettings(page, DELETED_TILE);
  await deleting.getByTestId('habit-settings-delete').click();
  await page.getByTestId('delete-habit-confirm-button').click();
  await expect(tile(page, DELETED_TILE)).toHaveCount(0);
  await exitMode(page);

  // --- Nothing went out, and nothing complained. ---
  nothingSent('delete');
  await expect(page.getByText(SYNC_FAILURE_TITLE)).toHaveCount(0);
  expect(dialogs).toEqual([]);
  // And nothing a demo tile was reached the on-device cache.
  const cached = await page.evaluate(
    (prefix) =>
      Object.keys(window.localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => window.localStorage.getItem(key) ?? '')
        .join('\n'),
    HABITS_CACHE_PREFIX,
  );
  for (const name of [...DEMO_NAMES, NEW_NAME]) expect(cached).not.toContain(name);

  // --- After a reload (the list still failing), the placeholders are as seeded. ---
  // Pins today's discard-on-reload (#2465, undecided): current, not endorsed.
  // The reload lands back on the Habits tab, whose URL the page is on.
  await page.reload();
  await expect(page.getByTestId('habits-list')).toBeVisible();
  await expect(page.getByText(HABITS_UNREACHABLE)).toBeVisible();
  await expectEveryDemoTile(page);
  await expect(tile(page, NEW_NAME)).toHaveCount(0);
  nothingSent('the reload');
});
