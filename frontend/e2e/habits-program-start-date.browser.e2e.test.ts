import { expect, test, type Page, type Response } from '@playwright/test';

import { STAGE_DURATIONS_DAYS } from '../src/constants/program';

import {
  backendUrl,
  bearer,
  dayKeyIn,
  openHabits,
  seedHabit,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';
import { instantAt } from './zonedClock';

/**
 * #3097: a habits-only person picks the day their program began, and every
 * reader counts from that one day.
 *
 * The server owns the anchor (`program_started_at`); the client used to keep a
 * second one of its own, set from the Energy Scaffolding picker and never sent
 * anywhere, while the picker itself offered only future dates the server would
 * now refuse. Here the real client drives the real server:
 *
 *  - the scaffolding picker offers nothing after today, and refuses tomorrow;
 *  - a past pick sends exactly one `PUT /stages/program-calendar`, carrying the
 *    date and nothing else, and a real `GET` reads that anchor back;
 *  - the Settings "Program start date" row -- reachable with or without habits
 *    -- changes it, sends a second PUT, re-lays the program habit from the new
 *    day, and re-paces the Map without a reload.
 *
 * The zone is pinned to UTC and checked against the server's record, and the
 * page clock is installed at midday on the host's today, so the oracle, the
 * page and the server count days from the same day.
 */

const PINNED_ZONE = 'UTC';
const PINNED_WALL = '12:00';
const PROGRAM_CALENDAR_PATH = '/stages/program-calendar';
const HABITS_PATH = '/habits/';
const HABIT_NAME = 'Dawn sit';
/** The scaffolding pick: inside the first stage. */
const FIRST_PICK_DAYS_BACK = 10;
/** The Settings edit: two 21-day stages have closed, so stage 3 is open. */
const EDIT_DAYS_BACK = 50;
const EDITED_STAGE = 3;
/** A stage still ahead of both picks, whose countdown the Map shows. */
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

const isProgramStartPut = (response: Response): boolean =>
  response.request().method() === 'PUT' &&
  new URL(response.url()).pathname === PROGRAM_CALENDAR_PATH;

/** Drive the scaffolding pass to its reorder step, where the start date is picked. */
async function openScaffoldingDate(page: Page): Promise<void> {
  await openHabits(page);
  await page.getByRole('button', { name: 'Start Energy Scaffolding' }).click();
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

test('a habits-only person picks the day their program began and every reader counts from it', async ({
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

  const sent: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === PROGRAM_CALENDAR_PATH) {
      sent.push(request.postDataJSON());
    }
  });
  await page.reload();

  // --- The scaffolding picker offers only days the program can have begun on.
  await openScaffoldingDate(page);
  const dateInput = page.getByLabel('Date', { exact: true });
  await expect(dateInput).toHaveAttribute('max', todayKey);
  const tomorrow = addDaysToKey(todayKey, 1);
  await dateInput.fill(tomorrow);
  await expect(dateInput).not.toHaveValue(tomorrow);
  const firstPick = addDaysToKey(todayKey, -FIRST_PICK_DAYS_BACK);
  await dateInput.fill(firstPick);
  await expect(dateInput).toHaveValue(firstPick);

  await page.getByTestId('continue-to-templates').click();
  const [scaffolded] = await Promise.all([
    page.waitForResponse(isProgramStartPut),
    page.getByTestId('finish-setup').click(),
  ]);
  expect(scaffolded.ok(), 'the server refused the scaffolding pick').toBe(true);
  expect(sent).toEqual([{ program_start_date: firstPick }]);

  const read = await page.request.get(`${backendUrl()}${PROGRAM_CALENDAR_PATH}`, {
    headers: bearer(token),
  });
  expect(read.ok()).toBe(true);
  const calendar = (await read.json()) as { program_started_at: string | null };
  expect(dayKeyIn(calendar.program_started_at!, PINNED_ZONE)).toBe(firstPick);

  await openMapFromHabits(page);
  await expect(page.getByTestId(`stage-unlock-${OBSERVED_STAGE}`)).toHaveText(
    countdown(FIRST_PICK_DAYS_BACK),
  );

  // --- Settings changes it afterwards, with no reload.
  await page.getByRole('button', { name: 'Open settings' }).filter({ visible: true }).click();
  await page.getByTestId('settings-row-program-start').click();
  await expect(page.getByTestId('program-start-settings-screen')).toBeVisible();
  const settingsInput = page.getByLabel('Date', { exact: true });
  await expect(settingsInput).toHaveValue(firstPick);
  await expect(settingsInput).toHaveAttribute('max', todayKey);
  const edit = addDaysToKey(todayKey, -EDIT_DAYS_BACK);
  await settingsInput.fill(edit);
  const [edited] = await Promise.all([
    page.waitForResponse(isProgramStartPut),
    page.getByTestId('save-program-start-button').click(),
  ]);
  expect(edited.ok(), 'the server refused the Settings edit').toBe(true);
  await expect(page.getByTestId('program-start-status')).toBeVisible();
  expect(sent).toEqual([{ program_start_date: firstPick }, { program_start_date: edit }]);

  const reread = await page.request.get(`${backendUrl()}${PROGRAM_CALENDAR_PATH}`, {
    headers: bearer(token),
  });
  const after = (await reread.json()) as { program_started_at: string; calendar_stage: number };
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
