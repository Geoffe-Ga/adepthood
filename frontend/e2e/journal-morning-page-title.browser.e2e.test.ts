import { expect, test } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

test('morning pages open dated and editable while ordinary new entries stay untitled', async ({
  page,
}) => {
  await signUp(page, 'morning-page-title');

  // The generic door remains generic: this feature must not leak a daily title
  // into New entry or the drawer path that shares its callback.
  await page.getByTestId('journal-new-entry').click();
  await expect(page.getByTestId('journal-title-input')).toHaveValue('');
  await page.getByTestId('journal-close-entry').click();

  const today = await page.evaluate(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  });
  await page.getByRole('button', { name: 'Begin a morning page' }).click();

  // React Navigation keeps the prior entry mounted under the active route;
  // the accessibility tree selects the one the writer can actually reach.
  const title = page.getByRole('textbox', { name: 'Entry title' });
  await expect(title).toHaveValue(`${today} Daily Journal`);
  await title.fill('A title I chose instead');
  await expect(title).toHaveValue('A title I chose instead');
});
