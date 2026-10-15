import { expect, test } from '@playwright/test';

import { dayKeyIn, openHabits, seedHabit, signUp, tokenFor } from './journalHabitsBrowserSupport';
import { instantAt } from './zonedClock';

/**
 * #3381: the quick date choices follow the local calendar day of a picker
 * that stays mounted across midnight.
 *
 * The picker used to build its "today", "next monday" and "first of next
 * month" candidates once per mount, so a picker left open from Sunday night
 * into Monday kept committing Sunday as today and the Monday it had just
 * reached as "next monday". Here the Energy Scaffolding date step is opened
 * at 23:59 on a Sunday in the user's zone, the page clock is moved past
 * midnight without firing a timer or touching the picker, and each choice is
 * pressed: the committed day must be Monday's view of the calendar.
 */

const USER_TIMEZONE = 'America/Los_Angeles';
const BEFORE_MIDNIGHT = '23:59';
const AFTER_MIDNIGHT = '00:01';
const DAYS_PER_WEEK = 7;
const SUNDAY = 0;
const MONDAY = 1;

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

function firstOfFollowingMonth(dayKey: string): string {
  const [year, month] = dayKey.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

for (const width of [390, 1280]) {
  test(`quick date choices commit the new local day after midnight at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.clock.install();
    const email = await signUp(page, `date-midnight-${width}`);
    await seedHabit(request, await tokenFor(request, email), 'Midnight date witness');

    const sunday = nextSunday(dayKeyIn(new Date().toISOString(), USER_TIMEZONE));
    const monday = addDays(sunday, 1);
    expect(weekdayOf(monday)).toBe(MONDAY);
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

    // Cross local midnight with the picker still mounted. setSystemTime moves
    // the wall clock without running a timer, so nothing re-renders the picker.
    await page.clock.setSystemTime(instantAt(monday, AFTER_MIDNIGHT, USER_TIMEZONE));
    const dateInput = page.getByLabel('Date', { exact: true });

    await page.getByRole('button', { name: 'Select next Monday', exact: true }).click();
    await expect(dateInput).toHaveValue(addDays(monday, DAYS_PER_WEEK));

    await page.getByRole('button', { name: 'Select today', exact: true }).click();
    await expect(dateInput).toHaveValue(monday);

    await page.getByRole('button', { name: 'Select first of next month', exact: true }).click();
    await expect(dateInput).toHaveValue(firstOfFollowingMonth(monday));
    await page.screenshot({ path: info.outputPath(`monday-${width}.png`) });
  });
}
