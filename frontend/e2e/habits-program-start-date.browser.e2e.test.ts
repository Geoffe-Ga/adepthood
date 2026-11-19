import { expect, test, type Page, type Response } from '@playwright/test';

import { STAGE_DURATIONS_DAYS } from '../src/constants/program';

import {
  backendUrl,
  bearer,
  dayKeyIn,
  openHabits,
  openReorder,
  seedHabit,
  sessionFor,
  setProgramAnchorDaysAgo,
  signUp,
} from './journalHabitsBrowserSupport';
import { instantAt } from './zonedClock';

/**
 * #3097, #3728, #3747: a person with habits corrects the pass they are in, then
 * opens their next pass on a day that has not come yet, moves that day from
 * Settings, replaces it from the scaffolding, and starts it now from Reorder.
 *
 * The server owns the anchor (`program_started_at`). Here the real client
 * drives the real server:
 *
 *  - with nothing pending, the Settings "Program start date" row corrects the
 *    running pass with a PUT, re-lays the program habit from the new day, and
 *    re-paces the Map without a reload;
 *  - the scaffolding picker offers days up to the served `pass_start_window`,
 *    one whole program ahead, and opens on today -- a new pass, not the
 *    running one; saving a future pick sends exactly one `POST /stages/passes`
 *    carrying the day and nothing else, and no PUT; a real `GET` reads the day
 *    back as `pending_pass_starts_on` while `program_started_at` stays on the
 *    running pass;
 *  - the Habits screen says when the next pass begins, and the Map still paces
 *    from the running pass;
 *  - while the pass is pending, Settings offers that pass's day instead of a
 *    correction (which would drop it), says before saving that a later day
 *    moves the pass, and moves it with one `POST /stages/passes` -- no PUT, and
 *    no habit row moves;
 *  - a second scaffolding save opens on the held day and replaces it;
 *  - the Reorder modal offers the pending day too, says today starts the pass
 *    today, and starts it with one POST: the pass opens on today, nothing is
 *    pending, and again no PUT is sent and no habit row moves.
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
/** The day Settings moves it to. */
const MOVED_PICK_DAYS_AHEAD = 17;
/** The day a second save replaces it with. */
const REPLACED_PICK_DAYS_AHEAD = 20;
const MOVES_SENTENCE = 'Saving moves your next pass to';
const STARTS_TODAY_SENTENCE =
  'Saving starts your next pass today; your current pass stays on Stats and progress.';
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

/** Every habit row's start date, by name, as the server holds them. */
async function habitStarts(page: Page, token: string): Promise<Record<string, string>> {
  const listed = await page.request.get(`${backendUrl()}${HABITS_PATH}`, {
    headers: bearer(token),
  });
  expect(listed.ok()).toBe(true);
  const rows = (await listed.json()) as Array<{ id: number; start_date: string }>;
  return Object.fromEntries(rows.map((row) => [String(row.id), row.start_date]));
}

async function readCalendar(page: Page, token: string): Promise<CalendarRead> {
  const read = await page.request.get(`${backendUrl()}${PROGRAM_CALENDAR_PATH}`, {
    headers: bearer(token),
  });
  expect(read.ok()).toBe(true);
  return (await read.json()) as CalendarRead;
}

/** From the Habits screen, drive the scaffolding pass to its reorder step. */
async function openScaffoldingDate(page: Page): Promise<void> {
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

/** From the reorder step, finish the pass and return the one POST it sent. */
async function finishScaffolding(page: Page): Promise<void> {
  await page.getByTestId('continue-to-templates').click();
  const [opened] = await Promise.all([
    page.waitForResponse((response) => isPost(response, PASSES_PATH)),
    page.getByTestId('finish-setup').click(),
  ]);
  expect(opened.ok(), 'the server refused the new pass').toBe(true);
}

async function openMapFromHabits(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Habits menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Map menu' })).toBeVisible();
}

async function openHabitsFromMap(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Map menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Habits', exact: true }).click();
  await expect(page.getByTestId('habits-list')).toBeVisible();
}

async function openProgramStartSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open settings' }).filter({ visible: true }).click();
  await page.getByTestId('settings-row-program-start').click();
  await expect(page.getByTestId('program-start-settings-screen')).toBeVisible();
}

/** Leave Settings for the Map it was opened from. */
async function backToMap(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Go back' }).click();
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Open Map menu' })).toBeVisible();
}

test('a person with habits corrects their pass, then holds, moves and starts the next one', async ({
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

  const puts: unknown[] = [];
  const posts: unknown[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path === PROGRAM_CALENDAR_PATH)
      puts.push(request.postDataJSON());
    if (request.method() === 'POST' && path === PASSES_PATH) posts.push(request.postDataJSON());
  });
  await page.reload();

  // --- With nothing pending, Settings corrects the pass the person is in.
  await openHabits(page);
  await openMapFromHabits(page);
  await expect(page.getByTestId(`stage-unlock-${OBSERVED_STAGE}`)).toHaveText(
    countdown(RUNNING_DAYS_BACK),
  );
  await openProgramStartSettings(page);
  const settingsInput = page.getByLabel('Date', { exact: true });
  await expect(settingsInput).toHaveValue(addDaysToKey(todayKey, -RUNNING_DAYS_BACK));
  const edit = addDaysToKey(todayKey, -EDIT_DAYS_BACK);
  await settingsInput.fill(edit);
  const [edited] = await Promise.all([
    page.waitForResponse(isProgramStartPut),
    page.getByTestId('save-program-start-button').click(),
  ]);
  expect(edited.ok(), 'the server refused the Settings edit').toBe(true);
  await expect(page.getByTestId('program-start-status')).toBeVisible();
  expect(puts).toEqual([{ program_start_date: edit }]);

  const corrected = await readCalendar(page, token);
  expect(dayKeyIn(corrected.program_started_at, PINNED_ZONE)).toBe(edit);
  expect(corrected.calendar_stage).toBe(EDITED_STAGE);
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
  await backToMap(page);
  await expect(page.getByTestId(`stage-unlock-${OBSERVED_STAGE}`)).toHaveText(
    countdown(EDIT_DAYS_BACK),
  );

  // --- The scaffolding picker offers the served pass window, future days included.
  await openHabitsFromMap(page);
  await openScaffoldingDate(page);
  const dateInput = page.getByLabel('Date', { exact: true });
  await expect(dateInput).toHaveValue(todayKey);
  await expect(dateInput).toHaveAttribute('max', corrected.pass_start_window!.latest);
  expect(corrected.pass_start_window!.latest > todayKey).toBe(true);
  const futurePick = addDaysToKey(todayKey, FUTURE_PICK_DAYS_AHEAD);
  await dateInput.fill(futurePick);
  await expect(dateInput).toHaveValue(futurePick);
  await finishScaffolding(page);
  expect(posts).toEqual([{ start_day: futurePick }]);
  expect(puts).toHaveLength(1);

  const held = await readCalendar(page, token);
  expect(held.pending_pass_starts_on).toBe(futurePick);
  expect(dayKeyIn(held.program_started_at, PINNED_ZONE)).toBe(edit);

  // --- Habits names the day; the Map still paces the running pass.
  await expect(page.getByTestId('pass-begins-notice')).toContainText('Your next pass begins');
  await openMapFromHabits(page);
  await expect(page.getByTestId(`stage-unlock-${OBSERVED_STAGE}`)).toHaveText(
    countdown(EDIT_DAYS_BACK),
  );

  // --- While it is pending, Settings offers its day, not a correction that would drop it.
  await openProgramStartSettings(page);
  await expect(page.getByTestId('save-program-start-button')).toHaveCount(0);
  const pendingInput = page.getByLabel('Date', { exact: true });
  await expect(pendingInput).toHaveValue(futurePick);
  // The scaffold picker's floor rule: never the running pass's own start.
  await expect(pendingInput).toHaveAttribute('min', addDaysToKey(edit, 1));
  await expect(pendingInput).toHaveAttribute('max', held.pass_start_window!.latest);
  const rowsBeforeMove = await habitStarts(page, token);
  const moved = addDaysToKey(todayKey, MOVED_PICK_DAYS_AHEAD);
  await pendingInput.fill(moved);
  await expect(page.getByTestId('pending-pass-sentence')).toContainText(MOVES_SENTENCE);
  const [movedPost] = await Promise.all([
    page.waitForResponse((response) => isPost(response, PASSES_PATH)),
    page.getByTestId('save-pending-pass-button').click(),
  ]);
  expect(movedPost.ok(), 'the server refused the moved pass').toBe(true);
  await expect(page.getByTestId('pending-pass-status')).toBeVisible();
  expect(posts).toEqual([{ start_day: futurePick }, { start_day: moved }]);
  expect(puts).toHaveLength(1);
  const movedRead = await readCalendar(page, token);
  expect(movedRead.pending_pass_starts_on).toBe(moved);
  expect(dayKeyIn(movedRead.program_started_at, PINNED_ZONE)).toBe(edit);
  expect(await habitStarts(page, token)).toEqual(rowsBeforeMove);

  // --- A second save opens on the held day and replaces it.
  await backToMap(page);
  await openHabitsFromMap(page);
  await openScaffoldingDate(page);
  const again = page.getByLabel('Date', { exact: true });
  await expect(again).toHaveValue(moved);
  const replacement = addDaysToKey(todayKey, REPLACED_PICK_DAYS_AHEAD);
  await again.fill(replacement);
  await finishScaffolding(page);
  expect(posts).toEqual([
    { start_day: futurePick },
    { start_day: moved },
    { start_day: replacement },
  ]);
  const replaced = await readCalendar(page, token);
  expect(replaced.pending_pass_starts_on).toBe(replacement);
  expect(dayKeyIn(replaced.program_started_at, PINNED_ZONE)).toBe(edit);

  // --- Reorder offers the pending day too; today starts the pass now.
  await expect(page.getByTestId('pass-begins-notice')).toBeVisible();
  const rowsBeforeStart = await habitStarts(page, token);
  await openReorder(page);
  await expect(page.getByTestId('reorder-start-date-input')).toHaveCount(0);
  const reorderPass = page.getByTestId('reorder-pass-date-input');
  await expect(reorderPass).toHaveValue(replacement);
  await reorderPass.fill(todayKey);
  await expect(page.getByTestId('reorder-pass-sentence')).toHaveText(STARTS_TODAY_SENTENCE);
  const [started] = await Promise.all([
    page.waitForResponse((response) => isPost(response, PASSES_PATH)),
    page.getByTestId('reorder-save-order').click(),
  ]);
  expect(started.ok(), 'the server refused to start the pass now').toBe(true);
  await expect(page.getByTestId('reorder-modal-card')).toBeHidden();
  expect(posts.at(-1)).toEqual({ start_day: todayKey });
  expect(puts).toHaveLength(1);
  const begun = await readCalendar(page, token);
  expect(begun.pending_pass_starts_on).toBeNull();
  expect(dayKeyIn(begun.program_started_at, PINNED_ZONE)).toBe(todayKey);
  await expect(page.getByTestId('pass-begins-notice')).toHaveCount(0);
  // Save Order re-sends the rows as they were laid: none of them moved.
  await expect.poll(() => habitStarts(page, token)).toEqual(rowsBeforeStart);
});
