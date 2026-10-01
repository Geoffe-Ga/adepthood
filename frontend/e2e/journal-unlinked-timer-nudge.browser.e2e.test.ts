import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { backendUrl, seedHabit, sessionFor, signUp } from './journalHabitsBrowserSupport';

/**
 * #3006: a finished writing session with no habit linked points to Settings,
 * and Settings opens on the writing-habit picker.
 *
 * Crossed end to end in a real browser against a live server:
 *
 *  - the first finished session carries the keep-this offer, alone: one
 *    invitation per note, so declining it does not swap in the pointer;
 *  - the NEXT finished session, the offer answered and `GET /ui-flags` still
 *    unlinked, carries the link-a-habit note instead;
 *  - "Go to Settings" lands on Settings with the writing-habit picker already
 *    open under its row, and choosing the writer's habit there PATCHes
 *    `/ui-flags` (read back out of band, never from the browser's state);
 *  - back on the page, the next finished session has no note at all.
 *
 * Time is Playwright's clock, as in `writing-timer-habit-link`: `fastForward`
 * jumps a whole twenty-minute session in one step.
 */

const HABIT_NAME = 'Morning pages';
const BODY = 'A page before the day starts asking for things.';
/** Past the default twenty-minute session, so the next tick lands it complete. */
const PAST_A_SESSION = '20:05';

async function linkedHabitId(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<number | null> {
  const response = await request.get(`${backendUrl()}/ui-flags`, { headers });
  expect(response.ok(), 'reading the ui flags back failed').toBe(true);
  return ((await response.json()) as { writing_session_habit_id: number | null })
    .writing_session_habit_id;
}

/** Start a session on the open page and run it out, re-opening a folded pill first. */
async function runASession(page: Page): Promise<void> {
  const folded = page.getByRole('button', { name: 'Open writing timer options' });
  if (await folded.isVisible()) await folded.click();
  await page.getByTestId('writing-timer-start').click();
  await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
  await page.clock.fastForward(PAST_A_SESSION);
  await expect(page.getByTestId('writing-session-banner')).toBeVisible();
}

test('an unlinked writing timer points to Settings, which opens on the habit picker', async ({
  page,
}) => {
  await page.clock.install();
  const email = await signUp(page, 'unlinked-timer-nudge');
  const { token } = await sessionFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  const habitId = await seedHabit(page.request, token, HABIT_NAME);
  expect(await linkedHabitId(page.request, headers)).toBeNull();

  await page.reload();
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-body-input').fill(BODY);

  // --- The first note is the offer's alone; declining it adds nothing. ---
  await runASession(page);
  await page.getByTestId('save-as-habit-decline').click();
  await expect(page.getByTestId('save-as-habit-offer')).toHaveCount(0);
  await expect(page.getByTestId('link-habit-nudge')).toHaveCount(0);

  // --- The next note points to Settings. ---
  await runASession(page);
  const banner = page.getByTestId('writing-session-banner');
  await expect(banner.getByTestId('link-habit-nudge')).toBeVisible();
  await expect(banner.getByRole('button', { name: "Don't show this note again" })).toBeVisible();
  await banner.getByTestId('link-habit-nudge-settings').click();

  // --- Settings opens on the writing-habit row, its picker already open. ---
  const journal = page.getByTestId('settings-group-journal');
  await expect(journal.getByTestId('settings-row-writing-habit')).toBeInViewport();
  await expect(journal.getByTestId('writing-habit-picker')).toBeVisible();
  await journal.getByTestId(`writing-habit-choose-${habitId}`).click();
  await expect(journal.getByTestId('writing-habit-picker')).toHaveCount(0);
  expect(await linkedHabitId(page.request, headers)).toBe(habitId);

  // --- Back on the page, a linked timer's note carries no pointer. ---
  await page.goBack();
  await expect(page.getByTestId('journal-body-input')).toBeVisible();
  await runASession(page);
  await expect(page.getByText(`${HABIT_NAME} checked off`)).toBeVisible();
  await expect(page.getByTestId('link-habit-nudge')).toHaveCount(0);
});
