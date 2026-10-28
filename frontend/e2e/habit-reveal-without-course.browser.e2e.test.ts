import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  backendUrl,
  bearer,
  openHabits,
  sessionFor,
  setProgramAnchorDaysAgo,
  showProgramProgress,
  signUp,
} from './journalHabitsBrowserSupport';

/**
 * #3071: the habits are a depth a person may take without the Course
 * (NORTH-STAR "take the habits without the course"), so the program cadence
 * has to carry a habits-only account past its first ring.
 *
 * Before the fix the only thing that ever gave an account a calendar anchor was
 * the Course router. Someone who kept habits and never opened the Course had no
 * progress row, the server read them as standing on stage 1 forever, and the
 * Purple habit -- and every ring after it -- stayed locked however long they
 * stayed.
 *
 * The journey therefore never touches the Course: a request guard fails the run
 * on any `/course/` call, so a passing run cannot be a Course read in disguise.
 *
 * Order is load-bearing. `showProgramProgress` runs BEFORE
 * `setProgramAnchorDaysAgo` because the anchor arrange provisions a row itself
 * (`tests.e2e.program_anchor`); called first, it would hand the account the
 * very anchor this journey exists to prove the habits read creates, and the
 * spec would pass against the bug. `show` provisions nothing and exits non-zero
 * when no row exists, which is exactly how this spec fails without the fix.
 *
 * The 21-day rewind is Beige's window, written as a literal so a reshaped
 * schedule fails here instead of moving the oracle with it. Rewinding to the
 * window's first day keeps the read off the midnight edge: the rewind runs
 * strictly before the read, so a midnight crossing can only add a day.
 */

const BEIGE_HABIT = 'Dawn sit';
const PURPLE_HABIT = 'Cold water';
const BEIGE_WINDOW_DAYS = 21;
const FIRST_STAGE = 1;
const HABITS_PATH = '/habits/';
const COURSE_PREFIX = '/course/';
const JOURNAL_MENU = 'Open Journal menu';
const HABITS_MENU = 'Open Habits menu';
const ISO_DATE_LENGTH = 10;
const MS_PER_DAY = 86_400_000;
/** The server buckets days in the account's zone; pin it so the seeded dates agree. */
const PINNED_ZONE = 'UTC';

test.use({ timezoneId: PINNED_ZONE });

/** `days` from now as the habit schema spells a date. */
function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * MS_PER_DAY).toISOString().slice(0, ISO_DATE_LENGTH);
}

/** Lay a locked habit on `stage`'s ring, as onboarding would. */
async function seedLadderedHabit(
  request: APIRequestContext,
  token: string,
  name: string,
  stage: string,
  startDate: string,
): Promise<void> {
  const response = await request.post(`${backendUrl()}${HABITS_PATH}`, {
    headers: bearer(token),
    data: {
      name,
      icon: '★',
      start_date: startDate,
      energy_cost: 2,
      energy_return: 4,
      stage,
      revealed: false,
    },
  });
  expect(response.ok(), `seeding ${name} failed with ${response.status()}`).toBe(true);
}

/** Every `/course/` path the page asked the server for. */
function watchCourseRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith(COURSE_PREFIX)) seen.push(pathname);
  });
  return seen;
}

/**
 * Reload and wait on the Habits screen for the list read the reveal runs inside.
 * A reload keeps the route, so the first one lands on the Journal the sign-up
 * left us on and the second on Habits itself.
 */
async function reloadHabits(page: Page): Promise<void> {
  const listRead = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === HABITS_PATH &&
      response.ok(),
  );
  await page.reload();
  const journalMenu = page.getByRole('button', { name: JOURNAL_MENU });
  const habitsMenu = page.getByRole('button', { name: HABITS_MENU });
  await expect(journalMenu.or(habitsMenu)).toBeVisible();
  if (await journalMenu.isVisible()) await openHabits(page);
  await expect(page.getByTestId('habits-list')).toBeVisible();
  await listRead;
}

test('a habits-only account reaches its Purple habit without ever opening the Course', async ({
  page,
}) => {
  const courseRequests = watchCourseRequests(page);
  const email = await signUp(page, 'habit-reveal-without-course');
  const { token, timezone } = await sessionFor(page.request, email);
  expect(timezone, 'the account did not take the pinned zone').toBe(PINNED_ZONE);
  await seedLadderedHabit(page.request, token, BEIGE_HABIT, 'Beige', isoDaysFromNow(0));
  await seedLadderedHabit(
    page.request,
    token,
    PURPLE_HABIT,
    'Purple',
    isoDaysFromNow(BEIGE_WINDOW_DAYS),
  );

  // --- Day 0: Beige is open, Purple waits, and the read gave the calendar an anchor. ---
  await reloadHabits(page);
  const list = page.getByTestId('habits-list');
  await expect(list.getByLabel(`${PURPLE_HABIT} locked`)).toBeVisible();
  await expect(list.getByLabel(`${BEIGE_HABIT} locked`)).toHaveCount(0);
  const provisioned = showProgramProgress(email);
  expect(provisioned.current_stage).toBe(FIRST_STAGE);
  expect(Number.isNaN(Date.parse(provisioned.program_started_at))).toBe(false);

  // --- Three weeks on: the calendar stands in Purple, and the habit opens. ---
  setProgramAnchorDaysAgo(email, BEIGE_WINDOW_DAYS);
  await reloadHabits(page);
  await expect(list.getByLabel(`${PURPLE_HABIT} locked`)).toHaveCount(0);
  await expect(list.getByText(PURPLE_HABIT, { exact: true })).toBeVisible();

  expect(courseRequests, 'the journey must never reach the Course').toEqual([]);
});
