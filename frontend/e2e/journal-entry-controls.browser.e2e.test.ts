import { expect, test, type Locator, type Page } from '@playwright/test';

import { setProgramAnchorSixDaysAgo, signUp } from './journalHabitsBrowserSupport';

/** WCAG / Candle & Ink touch floor (``touchTarget.minimum``), in CSS px. */
const TOUCH_TARGET_MIN = 44;
/** Sub-pixel rounding allowance for two boxes sharing one line. */
const SAME_LINE_TOLERANCE = 1;
/** Allowance for Finish sitting on the body input's centre line. */
const CENTRE_TOLERANCE = 2;
const PHOTOGRAPH_NAME = 'Photograph a page or screenshot and add its text to this entry';

interface RowGeometry {
  clientWidth: number;
  scrollWidth: number;
  centres: number[];
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** Everything the layout claims rest on, read in ONE settled frame (#2959). */
interface EntryFrame {
  camera: Box;
  close: Box;
  finish: Box;
  input: Box;
  exitRowClientWidth: number;
  exitRowScrollWidth: number;
  documentScrollWidth: number;
  innerWidth: number;
  /** key → camera → X → title, each strictly after the previous in DOM order. */
  focusOrderHolds: boolean;
}

/** Read the actual browser boxes: stylesheet intent alone cannot prove a row did not wrap. */
async function rowGeometry(row: Locator): Promise<RowGeometry> {
  return row.evaluate((element) => {
    // The rail's empty flank slots have no height; only visible controls share a line.
    const controls = (Array.from(element.children) as HTMLElement[]).filter(
      (control) => control.getBoundingClientRect().height > 0,
    );
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

/**
 * Measure the exit row, the rail and the page after two animation frames, so a
 * resize React Native Web is still delivering cannot split the reads across
 * two layouts.
 */
async function settledFrame(page: Page): Promise<EntryFrame> {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const byId = (id: string): HTMLElement => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      if (!(element instanceof HTMLElement)) throw new Error(`missing ${id}`);
      return element;
    };
    const box = (id: string) => {
      const r = byId(id).getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const order = [
      'journal-api-key-settings',
      'journal-photograph-page',
      'journal-close-entry',
      'journal-title-input',
    ].map(byId);
    const focusOrderHolds = order.every(
      (element, index) =>
        index === 0 ||
        (order[index - 1]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    );
    const exitRow = byId('journal-entry-exit-row');
    return {
      camera: box('journal-photograph-page'),
      close: box('journal-close-entry'),
      finish: box('journal-finish-button'),
      input: box('journal-body-input'),
      exitRowClientWidth: exitRow.clientWidth,
      exitRowScrollWidth: exitRow.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      focusOrderHolds,
    };
  });
}

const centreY = (b: Box): number => b.top + b.height / 2;
const centreX = (b: Box): number => b.left + b.width / 2;

/** The camera sits beside the X; Finish sits centred under the page. */
function expectEntryLayout(frame: EntryFrame): void {
  expect(Math.abs(centreY(frame.camera) - centreY(frame.close))).toBeLessThanOrEqual(
    SAME_LINE_TOLERANCE,
  );
  expect(frame.camera.right).toBeLessThanOrEqual(frame.close.left);
  expect(frame.camera.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
  expect(frame.camera.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
  expect(frame.exitRowScrollWidth).toBeLessThanOrEqual(frame.exitRowClientWidth + 1);
  expect(frame.documentScrollWidth).toBeLessThanOrEqual(frame.innerWidth);
  expect(Math.abs(centreX(frame.finish) - centreX(frame.input))).toBeLessThanOrEqual(
    CENTRE_TOLERANCE,
  );
  expect(frame.finish.top).toBeGreaterThanOrEqual(frame.input.bottom);
  expect(frame.focusOrderHolds).toBe(true);
}

test('journal entry camera joins the exit row, Finish centres under the page, and resonance uses the responsive margin', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const email = await signUp(page, 'journal-entry-controls');
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-title-input').fill('A page with steady controls');
  await page
    .getByTestId('journal-body-input')
    .fill('The controls should stay where the writer can find them.');

  const row = page.getByTestId('journal-writing-controls');
  const finish = page.getByRole('button', { name: 'Mark this entry finished' });
  const photograph = page
    .getByTestId('journal-entry-exit-row')
    .getByRole('button', { name: PHOTOGRAPH_NAME });
  await expect(finish).toBeVisible();
  await expect(photograph).toBeVisible();
  // Icon-only at every width: the phrase is its accessible name, never visible text.
  await expect(photograph).toHaveText('');
  await expect(row.getByTestId('journal-photograph-page')).toHaveCount(0);
  await expect(page.getByTestId('journal-page')).toHaveCSS('flex-direction', 'row');
  expectEntryLayout(await settledFrame(page));
  const wideRow = await rowGeometry(row);
  expect(Math.max(...wideRow.centres) - Math.min(...wideRow.centres)).toBeLessThanOrEqual(1);
  expect(wideRow.scrollWidth).toBeLessThanOrEqual(wideRow.clientWidth + 1);

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

  // At the exact two-column breakpoint the fixed margin is already present.
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(row).toBeVisible();
  const breakpointRow = await rowGeometry(row);
  expect(
    Math.max(...breakpointRow.centres) - Math.min(...breakpointRow.centres),
  ).toBeLessThanOrEqual(1);
  expect(breakpointRow.scrollWidth).toBeLessThanOrEqual(breakpointRow.clientWidth + 1);
  await expect(photograph).toHaveText('');
  await expect(margin.getByTestId('get-resonance-button')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  // ``setViewportSize`` resolves before React Native Web has necessarily
  // delivered the resize through ``useWindowDimensions``. Wait for the product
  // breakpoint itself before taking the settled frame.
  await expect(page.getByTestId('journal-page')).toHaveCSS('flex-direction', 'column');
  expectEntryLayout(await settledFrame(page));
  const narrowRow = await rowGeometry(row);
  expect(Math.max(...narrowRow.centres) - Math.min(...narrowRow.centres)).toBeLessThanOrEqual(1);
  expect(narrowRow.scrollWidth).toBeLessThanOrEqual(narrowRow.clientWidth + 1);
  await expect(photograph).toHaveText('');
  expect(await photograph.getAttribute('aria-label')).toBe(PHOTOGRAPH_NAME);
  await expect(margin.getByTestId('get-resonance-button')).toHaveCount(0);
  await expect(page.getByTestId('get-resonance-button')).toBeVisible();
  expect(
    await page
      .getByTestId('get-resonance-button')
      .evaluate((button) => getComputedStyle(button.parentElement as HTMLElement).position),
  ).toBe('absolute');

  // The worst-case rail: a reflection adds Sources beside Finish. Sources takes
  // the trailing flank, so Finish must still sit on the body input's centre.
  setProgramAnchorSixDaysAgo(email);
  await page.getByTestId('journal-close-entry').click();
  await page.reload();
  await page.setViewportSize({ width: 600, height: 800 });
  await page.getByTestId('journal-reflection-band').click();
  const reflectionRow = page.getByTestId('journal-writing-controls');
  const sources = reflectionRow
    .getByTestId('journal-writing-controls-trailing')
    .getByTestId('reflection-sources-toggle');
  await expect(sources).toBeVisible();
  await expect(sources).toHaveText('');
  // Finish only appears once the page has words; fill first so the centre
  // check below can never pass against an absent button.
  await page.getByTestId('journal-body-input').fill('What this stage asked of me.');
  await expect(finish).toBeVisible();
  await expect(page.getByTestId('journal-page')).toHaveCSS('flex-direction', 'row');
  await expect(reflectionRow.getByTestId('journal-photograph-page')).toHaveCount(0);
  await expect(photograph).toHaveText('');
  expectEntryLayout(await settledFrame(page));
  const reflectionGeometry = await rowGeometry(reflectionRow);
  expect(
    Math.max(...reflectionGeometry.centres) - Math.min(...reflectionGeometry.centres),
  ).toBeLessThanOrEqual(1);
  expect(reflectionGeometry.scrollWidth).toBeLessThanOrEqual(reflectionGeometry.clientWidth + 1);
});
