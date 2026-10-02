import { expect, test } from '@playwright/test';

import {
  dayKeyIn,
  frontendUrl,
  nextDayKey,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';

/**
 * "Don't show this again" retires the morning-pages tip for good, and
 * Settings → Journal → the "Offer morning pages" switch brings it back (#3005).
 *
 * The X only sets the tip aside for today (its own spec,
 * `journal-morning-pages-dismiss.browser.e2e.test.ts`). This is the other,
 * permanent decline, crossed end to end in a real browser: the keyboard
 * activates the link by its spoken name, focus is handed to "Start a review
 * early", the flag lands in the device's storage, the tip stays gone across a
 * reload AND across the next day, and the Settings row -- reached by URL, the
 * way a returning writer would -- puts it back on the shelf at once.
 */

/** The key the permanent decline is persisted under (`src/storage/morningPagesTipStorage.ts`). */
const NEVER_OFFER_KEY = '@adepthood/morning_pages_tip_never_offer';
/** `MORNING_PAGES_NEVER_A11Y`: the link's visible words first, then what it stops. */
const NEVER_NAME = 'Don’t show this again: stop offering morning pages on the shelf';

test('“Don’t show this again” retires the morning-pages tip until Settings offers it again', async ({
  page,
}) => {
  const email = await signUp(page, 'morning-pages-never');
  const { timezone } = await sessionFor(page.request, email);
  const band = page.getByTestId('journal-morning-pages-band');
  await expect(band).toBeVisible();

  // 1. Decline for good by keyboard, by the link's spoken name.
  await band.getByRole('button', { name: NEVER_NAME }).focus();
  await page.keyboard.press('Enter');
  await expect(band).toHaveCount(0);
  await expect(page.getByTestId('journal-review-early')).toBeFocused();
  expect(await page.evaluate((key) => localStorage.getItem(key), NEVER_OFFER_KEY)).toBe('true');

  // 2. Still gone after a reload the same day...
  await page.reload();
  await expect(page.getByTestId('journal-review-early')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(band).toHaveCount(0);

  // 3. ...and on the next day in the account's zone, where the X's set-aside
  // would have lapsed.
  const today = dayKeyIn(await page.evaluate(() => new Date().toISOString()), timezone);
  const tomorrow = nextDayKey(today);
  const tomorrowMidday = new Date(`${tomorrow}T12:00:00Z`);
  expect(dayKeyIn(tomorrowMidday.toISOString(), timezone), 'midday UTC is not that day here').toBe(
    tomorrow,
  );
  await page.clock.setFixedTime(tomorrowMidday);
  await page.reload();
  await expect(page.getByTestId('journal-review-early')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(band).toHaveCount(0);

  // 4. The way back is the writer's own choice, in Settings → Journal: the
  //    "Offer morning pages" switch, which the decline above turned off.
  await page.goto(`${frontendUrl()}/settings`);
  const offerSwitch = page.getByTestId('settings-row-morning-pages-offer-switch');
  await expect(offerSwitch).toBeEnabled();
  await expect(offerSwitch).not.toBeChecked();
  await offerSwitch.click();
  await expect(offerSwitch).toBeChecked();
  expect(await page.evaluate((key) => localStorage.getItem(key), NEVER_OFFER_KEY)).toBe('false');

  // 5. And the shelf offers it again.
  await page.goto(`${frontendUrl()}/journal`);
  await expect(page.getByTestId('journal-morning-pages-band')).toBeVisible();
});
