import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { backendUrl, seedHabit, sessionFor, signUp } from './journalHabitsBrowserSupport';

/**
 * #2861: a finished writing session checks off the habit the writer linked it to.
 *
 * Driven through the real page against a live server, because every claim here
 * is a seam the Jest specs can only agree with themselves about:
 *
 *  - the offer's "Which habit?" picker lists a habit the writer already has, by
 *    its own name, and choosing it PATCHes `/ui-flags` so the link survives on
 *    the server (read back out of band, never from the browser's state);
 *  - the NEXT finished session posts to `POST /goal_completions/` through the
 *    habit pipeline, and the server's day total shows ONE session: the seeded
 *    habit counts "units", and a session is one unit of a count habit (a habit
 *    kept in minutes would be credited the session's minutes instead);
 *  - a THIRD session the same day posts again and the day shows two: since
 *    #2852 explicit amounts accumulate on the server, and a second sitting is
 *    a second session, not a repeat of the first;
 *  - deleting the linked habit leaves `GET /ui-flags` unlinked.
 *
 * Time is Playwright's clock, installed before the app loads: a session is
 * twenty minutes of wall clock, and `fastForward` jumps it in one step so the
 * engine's next tick observes the whole session at once -- the same shape as a
 * device waking from the background, which the engine already bounds.
 */

const HABIT_NAME = 'Morning pages';
/** What one finished session credits a habit that counts "units". */
const ONE_SESSION = 1;
const TWO_SESSIONS = 2;
const BODY = 'The kettle, the window, and a page before anything else.';
/** Past the default twenty-minute session, so the next tick lands it complete. */
const PAST_A_SESSION = '20:05';

interface HabitRead {
  goals: Array<{
    tier: string;
    target: number;
    target_unit: string;
    completions?: Array<{ completed_units: number | null }>;
  }>;
}

async function readHabit(
  request: APIRequestContext,
  headers: Record<string, string>,
  habitId: number,
): Promise<HabitRead> {
  const response = await request.get(`${backendUrl()}/habits/${habitId}`, { headers });
  expect(response.ok(), 'reading the linked habit back failed').toBe(true);
  return (await response.json()) as HabitRead;
}

function loggedUnits(habit: HabitRead): number {
  return habit.goals
    .flatMap((goal) => goal.completions ?? [])
    .reduce((sum, completion) => sum + (completion.completed_units ?? 0), 0);
}

async function linkedHabitId(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<number | null> {
  const response = await request.get(`${backendUrl()}/ui-flags`, { headers });
  expect(response.ok(), 'reading the ui flags back failed').toBe(true);
  return ((await response.json()) as { writing_session_habit_id: number | null })
    .writing_session_habit_id;
}

/**
 * Start a session on the open page and run it out. A finished session leaves
 * the pill folded to its compact face, so it is opened first when it is.
 */
async function runASession(page: Page): Promise<void> {
  const folded = page.getByRole('button', { name: 'Open writing timer options' });
  if (await folded.isVisible()) await folded.click();
  await page.getByTestId('writing-timer-start').click();
  await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
  await page.clock.fastForward(PAST_A_SESSION);
  await expect(page.getByTestId('writing-session-banner')).toBeVisible();
}

test('a finished writing session checks off the habit the writer linked it to', async ({
  page,
}) => {
  await page.clock.install();
  const email = await signUp(page, 'writing-habit-link');
  const { token } = await sessionFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  const habitId = await seedHabit(page.request, token, HABIT_NAME);
  const lowUnit = (await readHabit(page.request, headers, habitId)).goals.find(
    (goal) => goal.tier === 'low',
  )?.target_unit;
  if (lowUnit === undefined) throw new Error('the seeded habit has no low tier to check off');
  expect(lowUnit, 'the credit rule below is the count-habit one').toBe('units');
  expect(await linkedHabitId(page.request, headers)).toBeNull();

  await page.reload();
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-body-input').fill(BODY);

  // --- The first session offers the link; the writer picks their own habit. ---
  await runASession(page);
  await page.getByTestId('save-as-habit-accept').click();
  await expect(page.getByText('Which habit?')).toBeVisible();
  await expect(page.getByTestId('writing-habit-new')).toBeVisible();
  await page.getByTestId(`writing-habit-choose-${habitId}`).click();
  await expect(page.getByTestId('save-as-habit-linked')).toContainText(
    `${HABIT_NAME} will be checked off when a timer ends.`,
  );
  expect(await linkedHabitId(page.request, headers)).toBe(habitId);
  // The session that made the offer ran before the link existed.
  expect(loggedUnits(await readHabit(page.request, headers, habitId))).toBe(0);

  // --- The next finished session checks it off: one session, one unit. ---
  const checkIn = page.waitForResponse(
    (response) =>
      response.url().endsWith('/goal_completions/') && response.request().method() === 'POST',
  );
  await runASession(page);
  expect((await checkIn).ok(), 'the check-off did not reach the server').toBe(true);
  await expect(page.getByText(`${HABIT_NAME} checked off`)).toBeVisible();
  expect(loggedUnits(await readHabit(page.request, headers, habitId))).toBe(ONE_SESSION);
  // A linked account is not asked again.
  await expect(page.getByTestId('save-as-habit-accept')).toHaveCount(0);

  // --- A third session the same day is a second session: it posts once more. ---
  let extraPosts = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/goal_completions/') && request.method() === 'POST') {
      extraPosts += 1;
    }
  });
  const secondCheckIn = page.waitForResponse(
    (response) =>
      response.url().endsWith('/goal_completions/') && response.request().method() === 'POST',
  );
  await runASession(page);
  expect((await secondCheckIn).ok(), 'the second check-off did not reach the server').toBe(true);
  await page.clock.fastForward('00:02');
  expect(extraPosts, 'one session must post exactly once').toBe(1);
  expect(loggedUnits(await readHabit(page.request, headers, habitId))).toBe(TWO_SESSIONS);

  // --- Deleting the habit unlinks the timer on the server. ---
  const deleted = await page.request.delete(`${backendUrl()}/habits/${habitId}`, { headers });
  expect(deleted.status()).toBe(204);
  expect(await linkedHabitId(page.request, headers)).toBeNull();
});
