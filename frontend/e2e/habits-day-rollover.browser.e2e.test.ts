import { expect, test, type Page } from '@playwright/test';

import {
  completionsOf,
  isCompletionPost,
  isHabitsListRead,
  litTierMarkers,
  readHabit,
  requestTally,
  restoreHabitsListReads,
  seedRevealedHabitDoneToday,
  simulateBackgroundAndForeground,
  stubHabitsListReadsNotFound,
} from './dayBoundaryBrowserSupport';
import {
  dayKeyIn,
  openHabits,
  openJournal,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';
import { instantAt } from './zonedClock';

/**
 * #2764 / #2847 / #2771: the day turns over on a habit screen that never
 * unmounted, and every way back onto one re-reads it.
 *
 * Three halves, one test each so an exact-count miss in one cannot hide the
 * others:
 *
 *  1. At local midnight the Habits tile that read "achieved today" reads
 *     not-done, on the same page with no reload. The boundary also re-reads
 *     the list (since #2847); that one read is answered 404 here, which the
 *     client neither retries nor applies, so the turnover is the client
 *     re-deriving "today" from the rows it already held -- not fresh server
 *     data. It does not isolate the tile's own day subscription: the read
 *     still toggles the store's loading flag, and the Habits screen swaps its
 *     whole grid for a spinner while that flag is set, so the tiles mount
 *     afresh either way. That subscription is pinned in Jest
 *     (HabitTileDayRollover.test.tsx).
 *  2. The journal shelf reads 1/1 done before midnight and 0/1 after, still
 *     mounted; then each drawer hop away and back costs exactly one list read
 *     -- the arrival is not double-fetched and the return is not skipped.
 *  3. Foregrounding the app onto the tab the user never left re-reads it once.
 *
 * The resumed-session half -- a stored token with no cached zone, reloaded west
 * of UTC -- is not here. Driven through this lane, the zone backfill's refresh
 * revokes the resumed token while the app's first requests still carry it;
 * their 401s then refresh a token that is already revoked, and the session is
 * signed out. That is a product defect (#3034), not a spec to write around, so
 * the half stays registered `uncovered` in journeys.json until it is fixed.
 *
 * Every fake page time is built from the day the SERVER recorded the
 * completion on, so a run straddling the account's real midnight cannot make
 * the arrange disagree with itself.
 */

const USER_TIMEZONE = 'America/Los_Angeles';
const HABIT_NAME = 'Evening stretch';
const PRE_MIDNIGHT_WALL = '23:58';
/** Two minutes to midnight plus one past it: the boundary timer is due inside the jump. */
const PAST_MIDNIGHT_SPAN = '03:00';
const MIDDAY_WALL = '12:00';
const ACHIEVED_TODAY = 'ACHIEVED TODAY!';
const SHELF_BEFORE = '1/1 done';
const SHELF_AFTER = '0/1 done';

test.use({ timezoneId: USER_TIMEZONE });

interface Arranged {
  token: string;
  habitId: number;
  localDay: string;
}

/**
 * A fresh account with one habit done today, the page reloaded onto the
 * journal at `wall` on the day the server recorded that completion.
 */
async function arrange(page: Page, prefix: string, wall: string): Promise<Arranged> {
  await page.clock.install();
  const email = await signUp(page, prefix);
  const { token, timezone } = await sessionFor(page.request, email);
  expect(timezone, 'the account did not take the browser zone').toBe(USER_TIMEZONE);
  const { habitId, localDay } = await seedRevealedHabitDoneToday(page.request, token, HABIT_NAME);
  const instant = instantAt(localDay, wall, USER_TIMEZONE);
  expect(dayKeyIn(instant.toISOString(), USER_TIMEZONE)).toBe(localDay);
  await page.clock.setSystemTime(instant);
  await page.reload();
  await expect(page.getByTestId('journal-habits-tile')).toBeVisible();
  return { token, habitId, localDay };
}

function habitTile(page: Page) {
  return page.getByTestId('habit-tile').filter({ hasText: HABIT_NAME });
}

test('a habit done before local midnight reads not-done-today after it, without a reload', async ({
  page,
}) => {
  const { token, habitId, localDay } = await arrange(page, 'day-rollover-tile', PRE_MIDNIGHT_WALL);
  await openHabits(page);
  const tile = habitTile(page);
  await expect(tile.getByTestId('habit-streak')).toContainText(ACHIEVED_TODAY);
  expect(await litTierMarkers(tile)).toBeGreaterThan(0);

  const listReads = requestTally(page, isHabitsListRead);
  const completionPosts = requestTally(page, isCompletionPost);
  await stubHabitsListReadsNotFound(page);
  await page.clock.fastForward(PAST_MIDNIGHT_SPAN);

  await expect(tile.getByTestId('habit-streak')).not.toContainText(ACHIEVED_TODAY);
  await expect.poll(() => litTierMarkers(tile)).toBe(0);
  // The focused screen re-reads at the boundary; the blurred shelf defers to
  // its own return.
  await listReads.expectSinceMark(1, 'the boundary should re-read the focused screen once');
  await completionPosts.expectSinceMark(0, 'the boundary must not rewrite a completion');
  await restoreHabitsListReads(page);

  // The day moved on the screen only: the completion is still the one it was.
  const completions = completionsOf(await readHabit(page.request, token, habitId));
  expect(completions).toHaveLength(1);
  expect(completions[0]?.local_day).toBe(localDay);
});

test('the journal shelf turns over at midnight, and each return re-reads exactly once', async ({
  page,
}) => {
  await arrange(page, 'day-rollover-shelf', PRE_MIDNIGHT_WALL);
  const shelf = page.getByTestId('journal-habits-tile');
  await expect(shelf).toContainText(SHELF_BEFORE);
  await page.clock.fastForward(PAST_MIDNIGHT_SPAN);
  await expect(shelf).toContainText(SHELF_AFTER);

  const listReads = requestTally(page, isHabitsListRead);
  await listReads.expectSinceMark(0, 'nothing should read while the shelf sits still');
  await openHabits(page);
  await listReads.expectSinceMark(1, 'arriving on Habits should read once, on mount');
  listReads.mark();
  await openJournal(page);
  await listReads.expectSinceMark(1, 'returning to the shelf should re-read once');
  listReads.mark();
  await openHabits(page);
  await listReads.expectSinceMark(1, 'returning to Habits should re-read once');
});

test('foregrounding the app onto the tab the user never left re-reads it once', async ({
  page,
}) => {
  await arrange(page, 'day-rollover-foreground', MIDDAY_WALL);
  await openHabits(page);
  await expect(habitTile(page).getByTestId('habit-streak')).toContainText(ACHIEVED_TODAY);

  const listReads = requestTally(page, isHabitsListRead);
  await listReads.expectSinceMark(0, 'nothing should read while the screen sits still');
  await simulateBackgroundAndForeground(page);
  await listReads.expectSinceMark(1, 'coming back to the foreground should re-read once');
});
