import { expect, test, type Page, type Response } from '@playwright/test';

import { STAGE_DURATIONS_DAYS } from '../src/constants/program';

import {
  backendUrl,
  bearer,
  dayKeyIn,
  openHabits,
  seedHabit,
  sessionFor,
  setProgramAnchorDaysAgo,
  signUp,
} from './journalHabitsBrowserSupport';
import { instantAt } from './zonedClock';

/**
 * #3097, #3728: a person with habits re-runs Energy Scaffolding and opens their
 * next pass on a day that has not come yet; the pass they are in keeps running.
 *
 * The server owns the anchor (`program_started_at`). Here the real client
 * drives the real server:
 *
 *  - the scaffolding picker offers days up to the served `pass_start_window`,
 *    one whole program ahead, and opens on today -- a new pass, not the
 *    running one;
 *  - saving a future pick sends exactly one `POST /stages/passes` carrying the
 *    day and nothing else, and no `PUT /stages/program-calendar`; a real `GET`
 *    reads the day back as `pending_pass_starts_on` while `program_started_at`
 *    stays on the running pass;
 *  - the Habits screen says when the next pass begins, and the Map still paces
 *    from the running pass;
 *  - the Settings "Program start date" row -- which corrects the pass the
 *    person is in -- changes it with a PUT, re-lays the program habit from the
 *    new day, and re-paces the Map without a reload.
 *
 * The zone is pinned to UTC and checked against the server's record, and the
 * page clock is installed at midday on the host's today, so the oracle, the
 * page and the server count days from the same day.
 */

const PINNED_ZONE = 'UTC';
const PINNED_WALL = '12:00';
const PROGRAM_CALENDAR_PATH = '/stages/program-calendar';
const PASSES_PATH = '/stages/passes';
const HABITS_PATH = '/habits/';
const HABIT_NAME = 'Dawn sit';
/** The running pass: inside the first stage. */
const RUNNING_DAYS_BACK = 10;
/** The next pass, held for a day that has not come. */
const FUTURE_PICK_DAYS_AHEAD = 13;
/** The Settings edit: two 21-day stages have closed, so stage 3 is open. */
const EDIT_DAYS_BACK = 50;
const EDITED_STAGE = 3;
/** A stage still ahead of both anchors, whose countdown the Map shows. */
const OBSERVED_STAGE = 4;
const OBSERVED_STAGE_OPENS_ON_DAY = STAGE_DURATIONS_DAYS.slice(0, OBSERVED_STAGE - 1).reduce(
  (sum, days) => sum + days,
  0,
);
const ISO_DATE_LENGTH = 10;

test.use({ timezoneId: PINNED_ZONE });

function addDaysToKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`not a YYYY-MM-DD day key: ${dayKey}`);
  }
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, ISO_DATE_LENGTH);
}

const countdown = (daysBack: number): string =>
  `Opens in ${OBSERVED_STAGE_OPENS_ON_DAY - daysBack} days`;

const isPost = (response: Response, path: string): boolean =>
  response.request().method() === 'POST' && new URL(response.url()).pathname === path;

const isProgramStartPut = (response: Response): boolean =>
  response.request().method() === 'PUT' &&
  new URL(response.url()).pathname === PROGRAM_CALENDAR_PATH;

interface CalendarRead {
  program_started_at: string;
  calendar_stage: number;
  pending_pass_starts_on: string | null;
  pass_start_window: { earliest: string; latest: string } | null;
}

async function readCalendar(page: Page, token: string): Promise<CalendarRead> {
  const read = await page.request.get(`${backendUrl()}${PROGRAM_CALENDAR_PATH}`, {
    headers: bearer(token),
  });
  expect(read.ok()).toBe(true);
  return (await read.json()) as CalendarRead;
}

/** Drive the scaffolding pass to its reorder step, where the start date is picked. */
async function openScaffoldingDate(page: Page): Promise<void> {
  await openHabits(page);
  await page.getByRole('button', { name: 'Start Energy Scaffolding' }).click();
  // The habit already held means this save opens a new pass, and says so.
  await expect(page.getByTestId('review-new-pass')).toBeVisible();
  await page.getByTestId('review-continue').click();
  await page.getByTestId('continue-button').click();
  await page.getByTestId('count-warning-continue').click();
  await page.getByTestId('continue-button').click();
  await page.getByTestId('continue-button').click();
  await expect(page.getByText('Beige begins on:', { exact: true })).toBeVisible();
}

async function openMapFromHabits(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Habits menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Map menu' })).toBeVisible();
}

test('a person with habits opens their next pass on a future day while the current one keeps running', async ({
  page,
}) => {
  const pinned = instantAt(
    dayKeyIn(new Date().toISOString(), PINNED_ZONE),
    PINNED_WALL,
    PINNED_ZONE,
  );
  await page.clock.install({ time: pinned });
  const todayKey = dayKeyIn(pinned.toISOString(), PINNED_ZONE);
  const email = await signUp(page, 'program-start-date');
  const { token, timezone } = await sessionFor(page.request, email);
  expect(timezone, 'the account did not take the pinned zone').toBe(PINNED_ZONE);
  await seedHabit(page.request, token, HABIT_NAME, todayKey);
  // The pass the person is in began RUNNING_DAYS_BACK ago (faked in the lane DB).
  setProgramAnchorDaysAgo(email, RUNNING_DAYS_BACK);
  const runningDay = addDaysToKey(todayKey, -RUNNING_DAYS_BACK);

  const puts: unknown[] = [];
  const posts: unknown[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path === PROGRAM_CALENDAR_PATH)
      puts.push(request.postDataJSON());
    if (request.method() === 'POST' && path === PASSES_PATH) posts.push(request.postDataJSON());
  });
  await page.reload();

  // --- The scaffolding picker offers the served pass window, future days included.
  const before = await readCalendar(page, token);
  await openScaffoldingDate(page);
  const dateInput = page.getByLabel('Date', { exact: true });
  await expect(dateInput).toHaveValue(todayKey);
  await expect(dateInput).toHaveAttribute('max', before.pass_start_window!.latest);
  expect(before.pass_start_window!.latest > todayKey).toBe(true);
  const futurePick = addDaysToKey(todayKey, FUTURE_PICK_DAYS_AHEAD);
  await dateInput.fill(futurePick);
  await expect(dateInput).toHaveValue(futurePick);

  await page.getByTestId('continue-to-templates').click();
  const [opened] = await Promise.all([
    page.waitForResponse((response) => isPost(response, PASSES_PATH)),
    page.getByTestId('finish-setup').click(),
  ]);
  expect(opened.ok(), 'the server refused the new pass').toBe(true);
  expect(posts).toEqual([{ start_day: futurePick }]);
  expect(puts).toEqual([]);

  const held = await readCalendar(page, token);
  expect(held.pending_pass_starts_on).toBe(futurePick);
  expect(dayKeyIn(held.program_started_at, PINNED_ZONE)).toBe(runningDay);

  // --- The Habits screen names the day; the Map still paces the running pass.
  await expect(page.getByTestId('pass-begins-notice')).toContainText('Your next pass begins');
  await openMapFromHabits(page);
  await expect(page.getByTestId(`stage-unlock-${OBSERVED_STAGE}`)).toHaveText(
    countdown(RUNNING_DAYS_BACK),
  );

  // --- Settings corrects the pass the person is in, with no reload.
  await page.getByRole('button', { name: 'Open settings' }).filter({ visible: true }).click();
  await page.getByTestId('settings-row-program-start').click();
  await expect(page.getByTestId('program-start-settings-screen')).toBeVisible();
  const settingsInput = page.getByLabel('Date', { exact: true });
  await expect(settingsInput).toHaveValue(runningDay);
  const edit = addDaysToKey(todayKey, -EDIT_DAYS_BACK);
  await settingsInput.fill(edit);
  const [edited] = await Promise.all([
    page.waitForResponse(isProgramStartPut),
    page.getByTestId('save-program-start-button').click(),
  ]);
  expect(edited.ok(), 'the server refused the Settings edit').toBe(true);
  await expect(page.getByTestId('program-start-status')).toBeVisible();
  expect(puts).toEqual([{ program_start_date: edit }]);
  expect(posts).toHaveLength(1);

  const after = await readCalendar(page, token);
  expect(dayKeyIn(after.program_started_at, PINNED_ZONE)).toBe(edit);
  expect(after.calendar_stage).toBe(EDITED_STAGE);

  // The program habit is re-laid from the new day through the reorder commit.
  await expect
    .poll(async () => {
      const listed = await page.request.get(`${backendUrl()}${HABITS_PATH}`, {
        headers: bearer(token),
      });
      const rows = (await listed.json()) as Array<{ name: string; start_date: string }>;
      return rows.find((row) => row.name === HABIT_NAME)?.start_date;
    })
    .toBe(edit);

  // Back to the Map it was opened from: it counts from the new day already.
  await page.getByRole('link', { name: 'Go back' }).click();
  await page.goBack();
  await expect(page.getByTestId(`stage-unlock-${OBSERVED_STAGE}`)).toHaveText(
    countdown(EDIT_DAYS_BACK),
  );
});
