import { expect, test } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

test('journal title stays one stored line while Return moves into the body', async ({ page }) => {
  await signUp(page, 'journal-title-line');
  await page.getByTestId('journal-new-entry').click();

  const title = page.getByTestId('journal-title-input');
  const body = page.getByTestId('journal-body-input');
  await expect(title).toHaveAttribute('rows', '1');
  const initialHeight = (await title.boundingBox())?.height;
  expect(initialHeight).toBeGreaterThan(0);

  await title.fill(
    'A long title that should wrap visually without changing its stored shape '.repeat(5),
  );
  await expect
    .poll(async () => (await title.boundingBox())?.height ?? 0)
    .toBeGreaterThan(initialHeight ?? 0);

  await title.fill('First line\n\nSecond line');
  await expect(title).toHaveValue('First line Second line');
  await title.press('Enter');
  await expect(body).toBeFocused();
  await expect(title).toHaveValue('First line Second line');

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await body.fill('Return put the caret in this body.');
  await page.getByTestId('journal-close-entry').click();
  const stored = (await (await created).json()) as { title: string };
  expect(stored.title).toBe('First line Second line');
});
