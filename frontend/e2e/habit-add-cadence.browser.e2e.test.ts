import { expect, test, type Page } from '@playwright/test';

import { STAGE_DURATIONS_DAYS } from '../src/constants/program';

import {
  backendUrl,
  bearer,
  dayKeyIn,
  logIn,
  seedHabit,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';
import { instantAt } from './zonedClock';

/**
 * #2708: a habit added after onboarding takes the next rung on the program
 * cadence, not the day it was added -- and so cannot undercut the program
 * anchor that is re-derived from the rows after a log-out wipes it.
 *
 * Nothing on a habit tile shows its date: a locked tile reads its stage, an
 * unlocked one its name, streak and tiers. The reorder modal does list dates,
 * but it re-lays every program row on the cadence the moment it opens, so it
 * would read the rung whatever the add had stamped; and the web build of the
 * date picker in habit settings renders nothing. So the journey is observed
 * where it can fail:
 *
 *  - on the wire: the add sheet's POST /habits/ carries the rung date for its
 *    slot, not today, and GET /habits/ echoes it back as a program row;
 *  - on the Map: with an anchor set in the future by the rows already there,
 *    a real log-out and log-in wipes the stored anchor and the app re-derives
 *    it from the rows -- and stage 2 still unlocks a future anchor's distance
 *    away. A today-stamped add would win that minimum and the Map would read
 *    stage 2 as one stage window from today.
 *
 * The zone is pinned to UTC and checked against the server's record, and the
 * page's clock is installed at midday on the host's today before the app
 * loads, so the oracle and every screen count days from the same day however
 * the run lines up with the real midnight -- a run straddling it would
 * otherwise read the Map a day later than the oracle and see one day fewer.
 * The clock still runs (a frozen one stalls the drawer's animation), and a
 * run is minutes long, so it cannot leave the pinned day. Only the browser's
 * clock is moved: nothing asserted here is a day the server stamps (each
 * start_date is the client's, stored verbatim), so the server running on real
 * time cannot disagree with it.
 *
 * The oracle is plain calendar arithmetic over the stage windows, deliberately
 * not the app's own `calculateHabitStartDate`.
 */

const PINNED_ZONE = 'UTC';
/** Midday: as far from either midnight as the pinned day allows. */
const PINNED_WALL = '12:00';
/** How far ahead of today the seeded rows put the program's start. */
const FUTURE_ANCHOR_DAYS = 30;
/** Program rows already on the ladder before the add; the add takes the next slot. */
const SEEDED_NAMES = ['Dawn sit', 'Cold water'];
const ADDED_SLOT = SEEDED_NAMES.length;
const ADDED_HABIT_NAME = 'Evening walk';
const OBSERVED_STAGE = 2;
const HABITS_PATH = '/habits/';
const PROGRAM_ANCHOR_KEY = '@adepthood/program_start_date';
const FIRST_STAGE_DAYS = STAGE_DURATIONS_DAYS[0];
const EXPECTED_COUNTDOWN = `Opens in ${FIRST_STAGE_DAYS + FUTURE_ANCHOR_DAYS} days`;
/** Length of the `YYYY-MM-DD` prefix of an ISO-8601 instant. */
const ISO_DATE_LENGTH = 10;

test.use({ timezoneId: PINNED_ZONE });

/** `days` calendar days after `dayKey`, by `Date.UTC` so no DST shift can skip one. */
function addDaysToKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`not a YYYY-MM-DD day key: ${dayKey}`);
  }
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, ISO_DATE_LENGTH);
}

/** The day program slot `slot` starts on: the anchor plus every stage window before it. */
function rungKey(anchorKey: string, slot: number): string {
  const offset = STAGE_DURATIONS_DAYS.slice(0, slot).reduce((sum, days) => sum + days, 0);
  return addDaysToKey(anchorKey, offset);
}

/** The Map counts days from the page's clock; prove it is still on the pinned day. */
async function expectPinnedDay(page: Page, todayKey: string): Promise<void> {
  const pageNow = await page.evaluate(() => new Date().toISOString());
  expect(dayKeyIn(pageNow, PINNED_ZONE), 'the page clock left the pinned day').toBe(todayKey);
}

async function openMapFromJournal(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Map menu' })).toBeVisible();
}

interface HabitRow {
  name: string;
  start_date: string;
  is_carryover: boolean;
}

test('an added habit takes its rung on the cadence and does not undercut the program anchor', async ({
  page,
}) => {
  const pinned = instantAt(
    dayKeyIn(new Date().toISOString(), PINNED_ZONE),
    PINNED_WALL,
    PINNED_ZONE,
  );
  await page.clock.install({ time: pinned });
  const todayKey = dayKeyIn(pinned.toISOString(), PINNED_ZONE);
  const email = await signUp(page, 'habit-add-cadence');
  const { token, timezone } = await sessionFor(page.request, email);
  expect(timezone, 'the account did not take the pinned zone').toBe(PINNED_ZONE);
  const anchorKey = addDaysToKey(todayKey, FUTURE_ANCHOR_DAYS);
  for (const [slot, name] of SEEDED_NAMES.entries()) {
    await seedHabit(page.request, token, name, rungKey(anchorKey, slot));
  }

  // The journal's habit load derives the anchor from the seeded rows.
  await page.reload();
  await expectPinnedDay(page, todayKey);
  await openMapFromJournal(page);
  await expect(page.getByTestId(`stage-unlock-${OBSERVED_STAGE}`)).toHaveText(EXPECTED_COUNTDOWN);

  // --- Add a habit through the sheet, and read what it sends. ---
  await page.getByRole('button', { name: 'Open Map menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Habits', exact: true }).click();
  await expect(page.getByTestId('habits-list')).toBeVisible();
  await page.getByRole('button', { name: 'Open Habits menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add Habit', exact: true }).click();
  const sheet = page.getByTestId('add-habit-modal');
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('add-habit-name').fill(ADDED_HABIT_NAME);
  // The response, not the request: the tile below is the optimistic row and
  // shows before the server has the habit, so only the answer says the
  // out-of-band read further down can find it.
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === HABITS_PATH,
    ),
    sheet.getByTestId('add-habit-save').click(),
  ]);
  expect(created.ok(), 'the add did not reach the server').toBe(true);
  const sent = created.request().postDataJSON() as { name: string; start_date: string };
  expect(sent.name).toBe(ADDED_HABIT_NAME);
  const expectedRung = rungKey(anchorKey, ADDED_SLOT);
  expect.soft(sent.start_date, 'the add should take its rung on the cadence').toBe(expectedRung);
  expect.soft(sent.start_date, 'the add must not be stamped today').not.toBe(todayKey);
  await expect(page.getByTestId('habit-tile').filter({ hasText: ADDED_HABIT_NAME })).toBeVisible();

  const listed = await page.request.get(`${backendUrl()}${HABITS_PATH}`, {
    headers: bearer(token),
  });
  expect(listed.ok(), 'reading the habit list back failed').toBe(true);
  const row = ((await listed.json()) as HabitRow[]).find(
    (habit) => habit.name === ADDED_HABIT_NAME,
  );
  expect.soft(row?.start_date, 'the server should store the rung it was sent').toBe(expectedRung);
  expect(row?.is_carryover).toBe(false);

  // --- Log out, which wipes the stored anchor, and come back. ---
  await page.getByRole('button', { name: 'Open settings' }).filter({ visible: true }).click();
  await page.getByTestId('settings-row-logout').click();
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), PROGRAM_ANCHOR_KEY), {
      message: 'logging out should forget the stored program anchor',
    })
    .toBeNull();
  await logIn(page, email);
  await expectPinnedDay(page, todayKey);

  // The anchor is re-derived from the rows -- the added one among them.
  await openMapFromJournal(page);
  await expect(page.getByTestId(`stage-unlock-${OBSERVED_STAGE}`)).toHaveText(EXPECTED_COUNTDOWN);
});
