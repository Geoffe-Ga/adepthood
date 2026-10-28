import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  ARTIFACTS,
  ROWS,
  expectTextWithinViewport,
  settings,
  logout,
  offered,
} from './declineOwnershipBrowserSupport';
import { logIn, signUp } from './journalHabitsBrowserSupport';

for (const width of [390, 1280]) {
  test(`device declines belong to their account, restore and reload at ${width}`, async ({
    page,
  }) => {
    // Four real sign-ins plus cold migration/reloads and storage-error controls
    // reached the final login at the original 60 s deadline in the trace. Keep
    // every action/expectation limit intact; budget this complete story alone.
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    const a = await signUp(page, 'decline-owner-a');
    // Arrange an upgrade from the old device-wide flags, retaining the real
    // prior account stamp. Cold Auth must record that provenance before any
    // stamp replacement, then carry only this account's legacy answers over.
    await page.evaluate(() => {
      const owner = localStorage.getItem('@adepthood/device_owner');
      if (owner === null) throw new Error('The signed-in account has no owner stamp');
      for (const key of [
        '@adepthood/writing_habit_offer_answered',
        '@adepthood/morning_pages_tip_never_offer',
        '@adepthood/link_habit_nudge_never_offer',
      ]) {
        localStorage.setItem(key, 'true');
        localStorage.removeItem(`${key}#u${owner}`);
      }
      localStorage.removeItem('@adepthood/legacy_decline_owner');
    });
    await page.reload();
    await settings(page);
    await offered(page, false);
    for (const row of ROWS)
      await page.getByTestId(`settings-row-${row}`).getByRole('switch').click();
    await offered(page, true);
    for (const row of ROWS)
      await page.getByTestId(`settings-row-${row}`).getByRole('switch').click();
    await offered(page, false);
    await page.reload();
    await offered(page, false);
    await logout(page);
    const b = await signUp(page, 'decline-owner-b');
    await settings(page);
    await offered(page, true);
    await logout(page);
    await logIn(page, a);
    await settings(page);
    await offered(page, false);
    // Exercise the real AsyncStorage write/error handling, with the device's
    // storage boundary refusing this restore once; no server outcome is faked.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith('@adepthood/writing_habit_offer_answered#u')) {
          Storage.prototype.setItem = original;
          throw new DOMException('Controlled storage failure', 'QuotaExceededError');
        }
        original.call(this, key, value);
      };
    });
    const refusedRestore = page.getByTestId('settings-row-writing-offer').getByRole('switch');
    await refusedRestore.click();
    await expect(refusedRestore).toBeEnabled();
    await expect(refusedRestore).not.toBeChecked();
    await page.reload();
    await offered(page, false);
    for (const row of ROWS)
      await page.getByTestId(`settings-row-${row}`).getByRole('switch').click();
    await offered(page, true);
    await page.reload();
    await offered(page, true);
    await page.getByTestId('settings-group-journal').evaluate((root) => {
      for (const element of root.querySelectorAll<HTMLElement>('*')) {
        if (element.childElementCount || !element.textContent?.trim()) continue;
        const style = getComputedStyle(element);
        element.style.fontSize = `${parseFloat(style.fontSize) * 2}px`;
        element.style.lineHeight = `${parseFloat(style.lineHeight) * 2}px`;
      }
    });
    for (const row of ROWS) {
      const control = page.getByTestId(`settings-row-${row}`).getByRole('switch');
      await control.scrollIntoViewIfNeeded();
      await control.focus();
      await expect(control).toBeFocused();
      await expectTextWithinViewport(page, `settings-row-${row}`);
      await page.keyboard.press('Space');
      await expect(control).not.toBeChecked();
      mkdirSync(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: join(ARTIFACTS, `settings-${row}-${width}-200.png`) });
    }
    await logout(page);
    await logIn(page, b);
    await settings(page);
    await offered(page, true);
  });
}
