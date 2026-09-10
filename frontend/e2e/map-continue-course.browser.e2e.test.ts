import { expect, test } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

/**
 * Issue #2795 — the stage modal's strongest action continues into that stage.
 *
 * The unit journey pins the navigation arguments and double-tap guard. This
 * browser journey proves the rendered hierarchy and the actual tab hand-off:
 * Course occurs once as the full-width Continue action, while Practice and
 * Journal are the two distinct secondary destinations.
 */
test('the Map stage modal continues into Course without offering Course twice', async ({
  page,
}) => {
  await signUp(page, 'map-continue-course');

  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Map menu' })).toBeVisible();

  // The current-stage magnifier deliberately sits over the stage hotspot and
  // owns that click; use the visible control a person actually presses.
  await page.getByTestId('map-magnifier').click();
  const modal = page.getByTestId('stage-modal');
  await expect(modal).toBeVisible();

  const continueToCourse = modal.getByRole('button', { name: 'Continue this stage' });
  await expect(continueToCourse).toHaveCount(1);
  await expect(continueToCourse).toContainText('Continue');

  const secondary = modal.getByTestId('stage-secondary-actions');
  await expect(secondary.getByRole('button', { name: 'Practice this stage' })).toHaveCount(1);
  await expect(secondary.getByRole('button', { name: 'Journal about this stage' })).toHaveCount(1);
  await expect(secondary.getByRole('button', { name: /Course/u })).toHaveCount(0);

  await continueToCourse.click();

  await expect(page.getByRole('button', { name: 'Open Course menu' })).toBeVisible();
  await expect(page.getByTestId('stage-cover')).toContainText('Chapter 1');
  await expect(page.getByTestId('stage-cover')).toContainText('Survival');
  await expect(modal).toBeHidden();
});
