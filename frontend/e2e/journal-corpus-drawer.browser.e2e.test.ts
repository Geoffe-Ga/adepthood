import { expect, test } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

test('the corpus remains in the Journal drawer after its invitation is set aside', async ({
  page,
}) => {
  await signUp(page, 'journal-corpus-drawer');

  const band = page.getByTestId('journal-voice-readiness-band');
  await expect(band).toBeVisible();

  // The permanent drawer door exists even while the one-time explanation is
  // still present, and both neighboring writing actions carry real icons.
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  const drawer = page.getByRole('dialog');
  const photograph = drawer.getByRole('button', { name: 'Photograph a page' });
  const corpus = drawer.getByRole('button', { name: 'Your corpus' });
  await expect(photograph.locator('svg')).toHaveCount(1);
  await expect(corpus.locator('svg')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close Journal menu' }).click();

  // Setting the explanatory band aside is durable, but never strands the
  // corpus: after a cold reload the drawer becomes its sole Journal surface.
  await page.getByTestId('journal-voice-readiness-dismiss').click();
  await expect(band).toHaveCount(0);
  await page.reload();
  await expect(band).toHaveCount(0);

  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await drawer.getByRole('button', { name: 'Your corpus' }).click();
  await expect(page.getByTestId('corpus-consent-screen')).toBeVisible();
  await expect(page.getByTestId('screen-drawer')).toHaveCount(0);
});
