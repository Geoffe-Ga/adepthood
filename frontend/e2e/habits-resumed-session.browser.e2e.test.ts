import { expect, test, type Request } from '@playwright/test';

import { requestTally, seedRevealedHabitDoneToday } from './dayBoundaryBrowserSupport';
import { dayKeyIn, openHabits, sessionFor, signUp } from './journalHabitsBrowserSupport';
import { instantAt } from './zonedClock';

/**
 * #2847 / #3034: a session resumed from a stored token with no cached zone
 * reads its own calendar, and gets there with exactly one token refresh.
 *
 * The device holds a session but not the zone -- an install that signed in
 * before #2847 started caching it. On resume the client asks the one endpoint
 * that reports the stored zone, `POST /auth/refresh`, which rotates the token
 * and revokes the old one while the app's first wave of reads is still
 * carrying it. Those reads 401. Before #3034 each 401 refreshed whatever token
 * the session held at that instant: a second refresh of a token the server had
 * just revoked, and the session signed out to the get-started screen (in
 * production the 1/minute limiter's 429 does the same; this lane disarms the
 * limiter, so the second refresh is counted rather than provoked).
 *
 * So the count is the assertion: exactly one refresh, held for a quiet window
 * in which a cascade would land. The spec does not care WHICH entry point
 * spent it -- the zone backfill, or the proactive refresh if the token were
 * already due -- only that the client spent one.
 *
 * The page clock reads late evening on the day the server recorded the
 * completion, in Los Angeles: UTC has already turned over and the user's day
 * has not. A session left on the UTC default would read the completion as
 * yesterday's; the resumed session must read it as today's. The completion's
 * time of day is the server's, so this is the one wall time that tells the two
 * calendars apart whatever hour the run happens at.
 */

const USER_TIMEZONE = 'America/Los_Angeles';
const HABIT_NAME = 'Evening stretch';
/** Late enough that UTC is on the next day; early enough that LA is not. */
const LATE_EVENING_WALL = '23:30';
const ACHIEVED_TODAY = 'ACHIEVED TODAY!';
/** `saveUserTimezone`'s AsyncStorage key, which react-native-web keeps in localStorage. */
const CACHED_ZONE_KEY = '@adepthood/user_timezone';
const REFRESH_PATH = '/auth/refresh';

test.use({ timezoneId: USER_TIMEZONE });

function isRefreshPost(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === REFRESH_PATH;
}

test('a resumed session with no cached zone refreshes once, stays signed in, and reads its own day', async ({
  page,
}) => {
  await page.clock.install();
  const email = await signUp(page, 'resumed-session');
  const { token, timezone } = await sessionFor(page.request, email);
  expect(timezone, 'the account did not take the browser zone').toBe(USER_TIMEZONE);
  const { localDay } = await seedRevealedHabitDoneToday(page.request, token, HABIT_NAME);
  const instant = instantAt(localDay, LATE_EVENING_WALL, USER_TIMEZONE);
  expect(dayKeyIn(instant.toISOString(), USER_TIMEZONE)).toBe(localDay);
  expect(dayKeyIn(instant.toISOString(), 'UTC'), 'UTC must already be on the next day').not.toBe(
    localDay,
  );

  // The device forgets the zone but keeps the session: a pre-#2847 install.
  await page.evaluate((key) => localStorage.removeItem(key), CACHED_ZONE_KEY);
  await page.clock.setSystemTime(instant);
  const refreshes = requestTally(page, isRefreshPost);
  await page.reload();

  // Still signed in: the journal, not the get-started screen.
  await expect(page.getByTestId('journal-habits-tile')).toBeVisible();
  await refreshes.expectSinceMark(1, 'a resumed session should refresh its token exactly once');
  await expect(page.getByRole('button', { name: 'I have a license key' })).toHaveCount(0);

  // The refresh carried the server's zone, and the device now caches it.
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), CACHED_ZONE_KEY))
    .toBe(USER_TIMEZONE);

  await openHabits(page);
  const tile = page.getByTestId('habit-tile').filter({ hasText: HABIT_NAME });
  await expect(tile.getByTestId('habit-streak')).toContainText(ACHIEVED_TODAY);

  // Nothing after the first wave signed the session out.
  await refreshes.expectSinceMark(1, 'opening Habits must not refresh the token again');
  await expect(page.getByTestId('habits-list')).toBeVisible();
});
