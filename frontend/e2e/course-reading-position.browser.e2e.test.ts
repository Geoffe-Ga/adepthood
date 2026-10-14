import { expect, test } from '@playwright/test';

import { frontendUrl, setProgramAnchorDaysAgo, signUp } from './journalHabitsBrowserSupport';

// The calendar is on Orange while the reader is still reading Blue.
const ORANGE_START_DAYS_AGO = 84;
const BLUE_STAGE = 4;
// Candle & Ink accent.primary: the visible selected-stage ring.
const SELECTED_STAGE_RING = 'rgb(165, 87, 47)';
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
];

for (const viewport of VIEWPORTS) {
  test(`Course restores the marked-read Frequency at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const email = await signUp(page, 'course-reading-position');
    setProgramAnchorDaysAgo(email, ORANGE_START_DAYS_AGO);
    await page.goto(`${frontendUrl()}/course/${BLUE_STAGE}`);
    await expect(page.getByTestId('stage-pill-4')).toHaveCSS(
      'border-top-color',
      SELECTED_STAGE_RING,
    );
    await page.locator('[data-testid^="content-card-"]').first().click();
    await expect(page.getByTestId('reader-markdown')).toBeVisible();
    // Scroll the actual reading sheet to its end; the read action only enables
    // after the reader's real scroll event reaches the final passage.
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, 100_000);
    const markRead = page.getByTestId('mark-read-button');
    await expect(markRead).toBeEnabled();
    await markRead.click();
    await expect(page.getByTestId('read-toast')).toBeVisible();
    await page.goto(`${frontendUrl()}/course`);
    await page.reload();
    await expect(page.getByTestId('stage-pill-4')).toHaveCSS(
      'border-top-color',
      SELECTED_STAGE_RING,
    );
    await expect(page.getByTestId('stage-cover')).toContainText('Chapter 4');
    await expect(page.getByTestId('stage-metadata')).toContainText('Blue');
    await page.screenshot({ path: `e2e/artifacts/course-reading-position-${viewport.width}.png` });
  });
}
