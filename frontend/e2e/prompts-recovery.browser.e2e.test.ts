import { expect, test } from '@playwright/test';

import { signUp, openPrompts } from './journalHabitsBrowserSupport';

test('a set-aside writing card can be recovered in Prompts while Journal stays quiet', async ({
  page,
}) => {
  await signUp(page, 'prompts-recovery');
  await expect(page.getByTestId('journal-morning-pages-band')).toHaveCount(0);
  await expect(page.getByTestId('journal-stat-tile-row')).toBeVisible();
  await openPrompts(page);
  await page.getByTestId('journal-morning-pages-dismiss').click();
  await expect(page.getByTestId('journal-morning-pages-band')).toHaveCount(0);
  await page.reload();
  await page.getByTestId('notification-bring-back-morning').click();
  await expect(page.getByTestId('journal-morning-pages-band')).toBeVisible();
  await page.getByRole('button', { name: 'Open Prompts menu' }).click();
  await page.getByTestId('drawer-nav-Journal').click();
  await expect(
    page.getByTestId('journal-shelf').getByTestId('journal-morning-pages-band'),
  ).toHaveCount(0);
});
