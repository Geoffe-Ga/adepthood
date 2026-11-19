import { expect, test } from '@playwright/test';

import {
  backendUrl,
  bearer,
  dayKeyIn,
  openHabits,
  seedHabit,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';
import { instantAt } from './zonedClock';

/**
 * #3381: the quick date choices follow the local calendar day of a picker
 * that stays mounted across midnight.
 *
 * The picker used to build its "today", "next monday" and "first of next
 * month" candidates once per mount, so a picker left open from Sunday night
 * into Monday kept committing Sunday as today. Here the Energy Scaffolding date
 * step is opened at 23:59 on a Sunday in the user's zone and the page clock is
 * run past midnight. After midnight "today" must commit Monday and "next
 * Monday" the Monday a week on; a per-mount memo would still hand back Sunday
 * and Monday, because the rollover re-renders the picker without remounting it.
 *
 * Only the page clock is faked: the server counts real time. The seeded habit
 * means this save opens a new pass (#3728), so the picker is clamped to the
 * pass window the server serves, which reaches one whole program past the
 * server's real today (#3725) and starts no later than the real signup day.
 * The faked Sunday is at most a week ahead, so every quick choice on both
 * sides of midnight falls inside that window and stays enabled; the spec reads
 * the served window and checks that before relying on it.
 */

const USER_TIMEZONE = 'America/Los_Angeles';
const BEFORE_MIDNIGHT = '23:59';
/** From 23:59, two minutes lands at 00:01 on the next local day. */
const MINUTES_PAST_MIDNIGHT = 2;
const MS_PER_MINUTE = 60_000;
const DAYS_PER_WEEK = 7;
const SUNDAY = 0;
const MONDAY = 1;
const HTTP_OK = 200;

/** The range `POST /stages/passes` accepts, as `GET /stages/program-calendar` serves it. */
interface ServedWindow {
  earliest: string;
  latest: string;
}

test.use({ timezoneId: USER_TIMEZONE });

/** `dayKey` shifted by `days` calendar days, through `Date.UTC` so DST cannot skip one. */
function addDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekdayOf(dayKey: string): number {
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The first Sunday strictly after `dayKey`, so the fake clock only moves forward. */
function nextSunday(dayKey: string): string {
  const ahead = (DAYS_PER_WEEK + SUNDAY - weekdayOf(dayKey)) % DAYS_PER_WEEK || DAYS_PER_WEEK;
  return addDays(dayKey, ahead);
}

/** The first of the month after `dayKey`'s, as the picker's "first of next month" builds it. */
function firstOfNextMonth(dayKey: string): string {
  const [year, month] = dayKey.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

/** Every quick choice offered on `today` lies strictly after the floor and within the ceiling. */
function expectChoicesInside(today: string, nextMonday: string, window: ServedWindow): void {
  for (const day of [today, nextMonday, firstOfNextMonth(today)]) {
    // Strictly above the floor: the client lifts a floor that is the running
    // pass's own start by a day, so this holds whichever start the server has.
    expect(day > window.earliest).toBe(true);
    expect(day <= window.latest).toBe(true);
  }
}

for (const width of [390, 1280]) {
  test(`quick date choices commit the new local day after midnight at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.clock.install();
    const email = await signUp(page, `date-midnight-${width}`);
    const token = await tokenFor(request, email);
    await seedHabit(request, token, 'Midnight date witness');
    const calendar = await request.get(`${backendUrl()}/stages/program-calendar`, {
      headers: bearer(token),
    });
    expect(calendar.status()).toBe(HTTP_OK);
    const served = (await calendar.json()) as { pass_start_window: ServedWindow | null };
    expect(served.pass_start_window).not.toBeNull();
    const window = served.pass_start_window!;

    const sunday = nextSunday(dayKeyIn(new Date().toISOString(), USER_TIMEZONE));
    const monday = addDays(sunday, 1);
    expect(weekdayOf(monday)).toBe(MONDAY);
    const mondayAfter = addDays(monday, DAYS_PER_WEEK);
    expectChoicesInside(sunday, monday, window);
    expectChoicesInside(monday, mondayAfter, window);
    await page.clock.setSystemTime(instantAt(sunday, BEFORE_MIDNIGHT, USER_TIMEZONE));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();

    await openHabits(page);
    await page.getByRole('button', { name: 'Start Energy Scaffolding' }).click();
    await page.getByTestId('review-continue').click();
    await page.getByTestId('continue-button').click();
    await page.getByTestId('count-warning-continue').click();
    await page.getByTestId('continue-button').click();
    await page.getByTestId('continue-button').click();
    await expect(page.getByText('Beige begins on:', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`sunday-${width}.png`) });

    const dateInput = page.getByLabel('Date', { exact: true });
    const nextMonday = page.getByRole('button', { name: 'Select next Monday', exact: true });
    const firstOfMonth = page.getByRole('button', {
      name: 'Select first of next month',
      exact: true,
    });
    const today = page.getByRole('button', { name: 'Select today', exact: true });
    await expect(today).toBeEnabled();
    await expect(nextMonday).toBeEnabled();
    await expect(firstOfMonth).toBeEnabled();

    // Cross local midnight with the picker still mounted. Running the clock
    // fires the day-rollover timer, which re-renders -- but does not remount --
    // the picker with Monday's candidates.
    await page.clock.runFor(MINUTES_PAST_MIDNIGHT * MS_PER_MINUTE);

    await today.click();
    await expect(dateInput).toHaveValue(monday);
    await expect(nextMonday).toBeEnabled();
    await expect(firstOfMonth).toBeEnabled();
    await nextMonday.click();
    await expect(dateInput).toHaveValue(mondayAfter);
    await firstOfMonth.click();
    await expect(dateInput).toHaveValue(firstOfNextMonth(monday));
    await page.screenshot({ path: info.outputPath(`monday-${width}.png`) });
  });
}
