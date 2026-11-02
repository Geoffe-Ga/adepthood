import { expect, test, type Locator, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

/**
 * On a phone the idle writing timer is a tray below the paper. It must not butt
 * against the sheet, and minimizing it must not leave a pill in the column:
 * the timer waits as an icon in the page's top-right exit row until the writer
 * reaches for it, and the paper takes back the height the tray held.
 */
const PHONE = { width: 390, height: 844 } as const;
/** Paper the idle tray leaves below the sheet (``IDLE_DOCK_TOP_GAP``): the two never touch. */
const MIN_TRAY_GAP = 12;

async function heightOf(locator: Locator, name: string): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${name} has no laid-out box`);
  return box.height;
}

/** Paper between the sheet's bottom edge and the timer's top, read in one task. */
async function trayGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rect = (id: string) =>
      document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect() ?? null;
    const timer = rect('writing-timer-pill');
    const sheet = rect('journal-sheet');
    if (!timer || !sheet) throw new Error('the timer or the sheet is missing');
    return timer.top - sheet.bottom;
  });
}

test('a minimized phone timer waits in the header and gives the paper its room', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  try {
    await signUp(page, 'timer-stow');
    await page.getByTestId('journal-new-entry').click();
    await page.getByTestId('journal-body-input').fill('A page with the timer put away.');
    const sheet = page.getByTestId('journal-sheet');
    await expect(page.getByTestId('writing-timer-pill')).toBeVisible();
    await expect(sheet).toHaveCSS('opacity', '1');
    await expect
      .poll(() => trayGap(page), { message: 'the idle tray must not touch the paper' })
      .toBeGreaterThanOrEqual(MIN_TRAY_GAP);
    const trayedHeight = await heightOf(sheet, 'sheet beside the tray');
    await page.screenshot({ path: testInfo.outputPath('stow-390-tray.png') });

    await page.getByTestId('writing-timer-minimize').click();
    await expect(page.getByTestId('writing-timer-pill')).toHaveCount(0);
    const icon = page
      .getByTestId('journal-entry-exit-row')
      .getByTestId('journal-writing-timer-open');
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('aria-label', 'Open the writing timer');
    await expect
      .poll(() => heightOf(sheet, 'sheet with the timer stowed'), {
        message: 'the paper takes back the height the tray held',
      })
      .toBeGreaterThan(trayedHeight + MIN_TRAY_GAP);
    await page.screenshot({ path: testInfo.outputPath('stow-390-stowed.png') });

    await icon.click();
    await expect(page.getByTestId('journal-writing-timer-open')).toHaveCount(0);
    await expect(page.getByTestId('writing-timer-preset-45')).toBeVisible();
    await expect.poll(() => trayGap(page)).toBeGreaterThanOrEqual(MIN_TRAY_GAP);
    await page.getByTestId('writing-timer-start').click();
    await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
  } finally {
    await context.close();
  }
});
