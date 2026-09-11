import { expect, test, type Locator } from '@playwright/test';

import { setProgramAnchorSixDaysAgo, signUp } from './journalHabitsBrowserSupport';

interface RowGeometry {
  clientWidth: number;
  scrollWidth: number;
  centres: number[];
}

/** Read the actual browser boxes: stylesheet intent alone cannot prove a row did not wrap. */
async function rowGeometry(row: Locator): Promise<RowGeometry> {
  return row.evaluate((element) => {
    const controls = Array.from(element.children) as HTMLElement[];
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      centres: controls.map((control) => {
        const box = control.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
    };
  });
}

test('journal entry actions remain one row and resonance uses the responsive margin', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const email = await signUp(page, 'journal-entry-controls');
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-title-input').fill('A page with steady controls');
  await page
    .getByTestId('journal-body-input')
    .fill('The controls should stay where the writer can find them.');

  const row = page.getByTestId('journal-writing-controls');
  const finish = page.getByRole('button', { name: 'Mark this entry finished' });
  const photograph = page.getByRole('button', {
    name: 'Photograph a handwritten page and add the transcription to this entry',
  });
  await expect(finish).toBeVisible();
  await expect(photograph).toContainText('Photograph a page');
  const wideRow = await rowGeometry(row);
  expect(Math.max(...wideRow.centres) - Math.min(...wideRow.centres)).toBeLessThanOrEqual(1);
  expect(wideRow.scrollWidth).toBeLessThanOrEqual(wideRow.clientWidth + 1);
  expect(await photograph.evaluate((element) => getComputedStyle(element).flexDirection)).toBe(
    'row',
  );

  const margin = page.getByTestId('journal-margin-column');
  const resonance = margin.getByTestId('get-resonance-button');
  await expect(resonance).toBeVisible();
  const widePlacement = await resonance.evaluate((button) => {
    const marginElement = button.closest('[data-testid="journal-margin-column"]');
    if (!(marginElement instanceof HTMLElement)) throw new Error('resonance left the margin');
    const buttonBox = button.getBoundingClientRect();
    const marginBox = marginElement.getBoundingClientRect();
    return {
      buttonCenter: buttonBox.left + buttonBox.width / 2,
      marginCenter: marginBox.left + marginBox.width / 2,
      wrapperPosition: getComputedStyle(button.parentElement as HTMLElement).position,
    };
  });
  expect(Math.abs(widePlacement.buttonCenter - widePlacement.marginCenter)).toBeLessThanOrEqual(2);
  expect(widePlacement.wrapperPosition).not.toBe('absolute');

  let releaseUsage: (() => void) | undefined;
  const usageHeld = new Promise<void>((resolve) => {
    releaseUsage = resolve;
  });
  await page.route('**/user/usage', async (route) => {
    await usageHeld;
    await route.continue();
  });
  await resonance.click();
  await expect(resonance).toContainText('Checking…');
  const checkingGeometry = await resonance.evaluate((button) => {
    const buttonBox = button.getBoundingClientRect();
    const marginBox = button
      .closest('[data-testid="journal-margin-column"]')!
      .getBoundingClientRect();
    return { buttonWidth: buttonBox.width, marginWidth: marginBox.width };
  });
  expect(checkingGeometry.buttonWidth).toBeLessThanOrEqual(checkingGeometry.marginWidth);
  releaseUsage?.();
  await expect(page.getByTestId('resonance-explainer-card')).toBeVisible();
  await page.getByTestId('resonance-explainer-cancel').click();
  await page.unroute('**/user/usage');

  // At the exact two-column breakpoint the fixed margin is already present,
  // but the writing rail is not yet wide enough for secondary labels.
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(row).toBeVisible();
  const breakpointRow = await rowGeometry(row);
  expect(
    Math.max(...breakpointRow.centres) - Math.min(...breakpointRow.centres),
  ).toBeLessThanOrEqual(1);
  expect(breakpointRow.scrollWidth).toBeLessThanOrEqual(breakpointRow.clientWidth + 1);
  await expect(photograph).toHaveText('');
  await expect(margin.getByTestId('get-resonance-button')).toBeVisible();

  await page.setViewportSize({ width: 375, height: 800 });
  await expect(row).toBeVisible();
  const narrowRow = await rowGeometry(row);
  expect(Math.max(...narrowRow.centres) - Math.min(...narrowRow.centres)).toBeLessThanOrEqual(1);
  expect(narrowRow.scrollWidth).toBeLessThanOrEqual(narrowRow.clientWidth + 1);
  await expect(photograph).toHaveText('');
  expect(await photograph.getAttribute('aria-label')).toContain('Photograph a handwritten page');
  await expect(margin.getByTestId('get-resonance-button')).toHaveCount(0);
  await expect(page.getByTestId('get-resonance-button')).toBeVisible();
  expect(
    await page
      .getByTestId('get-resonance-button')
      .evaluate((button) => getComputedStyle(button.parentElement as HTMLElement).position),
  ).toBe('absolute');

  // Exercise the worst-case writing rail in Chromium: reflection adds Sources,
  // so all three controls must still share one measured line at the breakpoint.
  setProgramAnchorSixDaysAgo(email);
  await page.getByTestId('journal-close-entry').click();
  await page.reload();
  await page.setViewportSize({ width: 600, height: 800 });
  await page.getByTestId('journal-reflection-band').click();
  const reflectionRow = page.getByTestId('journal-writing-controls');
  const reflectionPhotograph = page.getByTestId('journal-photograph-page');
  const sources = page.getByTestId('reflection-sources-toggle');
  await expect(sources).toBeVisible();
  await expect(reflectionPhotograph).toHaveText('');
  await expect(sources).toHaveText('');
  const reflectionGeometry = await rowGeometry(reflectionRow);
  expect(
    Math.max(...reflectionGeometry.centres) - Math.min(...reflectionGeometry.centres),
  ).toBeLessThanOrEqual(1);
  expect(reflectionGeometry.scrollWidth).toBeLessThanOrEqual(reflectionGeometry.clientWidth + 1);
});
