import { expect, test, type Locator, type Page } from '@playwright/test';

import { setProgramAnchorSixDaysAgo, signUp } from './journalHabitsBrowserSupport';

/**
 * Every control on the journal entry screen has one home, at every width
 * (#2975, #3002, #3004):
 *
 * - the exit row holds the page-level doors as glyphs:
 *   [Return?][Key][Sources? (writing a reflection)][Edit (reading) | Camera (writing)][X];
 * - under the body sit the body's own tools: the formatting toolbar, the save
 *   footer, then Finish alone and centred (writing), or Promote (reading);
 * - the margin hosts Get resonance, beside the page on a wide screen and
 *   stacked under it on a phone — never floating over the writing.
 */

/** WCAG / Candle & Ink touch floor (``touchTarget.minimum``), in CSS px. */
const TOUCH_TARGET_MIN = 44;
/** Sub-pixel rounding allowance for two boxes sharing one line. */
const SAME_LINE_TOLERANCE = 1;
/** Allowance for Finish sitting on the body input's centre line. */
const CENTRE_TOLERANCE = 2;
const PHOTOGRAPH_NAME = 'Photograph a page or screenshot and add its text to this entry';
const SOURCES_NAME = 'Open the sources to reread earlier writing and gather quotes';
const EDIT_NAME = 'Edit this entry';
const LAPTOP = { width: 1280, height: 720 } as const;
const BREAKPOINT = { width: 600, height: 800 } as const;
const PHONE = { width: 390, height: 844 } as const;
const NARROW_PHONE = { width: 375, height: 812 } as const;

/** The exit row and the page's order while writing a plain entry. */
const WRITING_ORDER = [
  'journal-api-key-settings',
  'journal-photograph-page',
  'journal-close-entry',
  'journal-title-input',
];
/** The same while writing a reflection: Sources joins the doors, left of the camera. */
const REFLECTION_ORDER = [
  'journal-api-key-settings',
  'reflection-sources-toggle',
  'journal-photograph-page',
  'journal-close-entry',
  'journal-title-input',
];

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

/** Everything the writing layout's claims rest on, read in ONE settled frame (#2959). */
interface EntryFrame {
  camera: Box;
  close: Box;
  finish: Box;
  input: Box;
  toolbar: Box;
  wordCount: Box;
  exitRow: RowGeometry;
  documentScrollWidth: number;
  innerWidth: number;
  /** The named controls, each strictly after the previous in DOM (and Tab) order. */
  focusOrderHolds: boolean;
}

/** Read the actual browser boxes: stylesheet intent alone cannot prove a row did not wrap. */
async function rowGeometry(row: Locator): Promise<RowGeometry> {
  return row.evaluate((element) => {
    // Only controls that render share a line; an empty host has no height.
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
 * Measure the exit row, the body's tools and the page after two animation
 * frames, so a resize React Native Web is still delivering cannot split the
 * reads across two layouts.
 */
async function settledFrame(page: Page, order: string[]): Promise<EntryFrame> {
  return page.evaluate(async (ids) => {
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
    const ordered = ids.map(byId);
    const focusOrderHolds = ordered.every(
      (element, index) =>
        index === 0 ||
        (ordered[index - 1]!.compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    );
    const exitRow = byId('journal-entry-exit-row');
    const controls = (Array.from(exitRow.children) as HTMLElement[]).filter(
      (control) => control.getBoundingClientRect().height > 0,
    );
    return {
      camera: box('journal-photograph-page'),
      close: box('journal-close-entry'),
      finish: box('journal-finish-button'),
      input: box('journal-body-input'),
      toolbar: box('journal-format-toolbar'),
      wordCount: box('journal-word-count'),
      exitRow: {
        clientWidth: exitRow.clientWidth,
        scrollWidth: exitRow.scrollWidth,
        centres: controls.map((control) => {
          const r = control.getBoundingClientRect();
          return r.top + r.height / 2;
        }),
      },
      documentScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      focusOrderHolds,
    };
  }, order);
}

const centreY = (b: Box): number => b.top + b.height / 2;
const centreX = (b: Box): number => b.left + b.width / 2;

/** All of a row's controls on one line, and the row itself never scrolling sideways. */
function expectOneLine(row: RowGeometry): void {
  expect(row.centres.length).toBeGreaterThan(0);
  expect(Math.max(...row.centres) - Math.min(...row.centres)).toBeLessThanOrEqual(
    SAME_LINE_TOLERANCE,
  );
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
}

/**
 * The camera sits beside the X on one exit-row line; under the body come the
 * toolbar, the save footer, then Finish centred; nothing scrolls sideways.
 */
function expectWritingLayout(frame: EntryFrame): void {
  expect(Math.abs(centreY(frame.camera) - centreY(frame.close))).toBeLessThanOrEqual(
    SAME_LINE_TOLERANCE,
  );
  expect(frame.camera.right).toBeLessThanOrEqual(frame.close.left);
  expect(frame.camera.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
  expect(frame.camera.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
  expectOneLine(frame.exitRow);
  expect(frame.documentScrollWidth).toBeLessThanOrEqual(frame.innerWidth);
  expect(frame.toolbar.top).toBeGreaterThanOrEqual(frame.input.bottom);
  expect(frame.wordCount.top).toBeGreaterThanOrEqual(frame.toolbar.bottom);
  expect(frame.finish.top).toBeGreaterThanOrEqual(frame.wordCount.bottom);
  expect(Math.abs(centreX(frame.finish) - centreX(frame.input))).toBeLessThanOrEqual(
    CENTRE_TOLERANCE,
  );
  expect(frame.focusOrderHolds).toBe(true);
}

/** Get resonance sits in the margin, in the page flow, and nowhere else. */
async function expectResonanceInMargin(page: Page): Promise<void> {
  const resonance = page.getByTestId('journal-margin-column').getByTestId('get-resonance-button');
  await expect(resonance).toBeVisible();
  await expect(page.getByTestId('get-resonance-button')).toHaveCount(1);
  expect(
    await resonance.evaluate((button) => getComputedStyle(button.parentElement!).position),
  ).not.toBe('absolute');
}

/** Wait for the product breakpoint itself, not just the resize call (#2959). */
async function resize(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await expect(page.getByTestId('journal-page')).toHaveCSS(
    'flex-direction',
    size.width < BREAKPOINT.width ? 'column' : 'row',
  );
}

test('journal entry controls keep one home each while writing and reading, at phone and desktop widths', async ({
  page,
}) => {
  await page.setViewportSize(LAPTOP);
  const email = await signUp(page, 'journal-entry-controls');
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-title-input').fill('A page with steady controls');
  await page
    .getByTestId('journal-body-input')
    .fill('The controls should stay where the writer can find them.');

  const row = page.getByTestId('journal-writing-controls');
  const exitRow = page.getByTestId('journal-entry-exit-row');
  const finish = page.getByRole('button', { name: 'Mark this entry finished' });
  const photograph = exitRow.getByRole('button', { name: PHOTOGRAPH_NAME });
  await expect(finish).toBeVisible();
  await expect(photograph).toBeVisible();
  // Icon-only at every width: the phrase is its accessible name, never visible text.
  await expect(photograph).toHaveText('');
  await expect(row.getByTestId('journal-photograph-page')).toHaveCount(0);
  await expect(exitRow.getByTestId('journal-edit-button')).toHaveCount(0);
  await expect(page.getByTestId('journal-page')).toHaveCSS('flex-direction', 'row');
  expectWritingLayout(await settledFrame(page, WRITING_ORDER));
  expectOneLine(await rowGeometry(row));

  const margin = page.getByTestId('journal-margin-column');
  const resonance = margin.getByTestId('get-resonance-button');
  await expectResonanceInMargin(page);
  const widePlacement = await resonance.evaluate((button) => {
    const marginElement = button.closest('[data-testid="journal-margin-column"]');
    if (!(marginElement instanceof HTMLElement)) throw new Error('resonance left the margin');
    const buttonBox = button.getBoundingClientRect();
    const marginBox = marginElement.getBoundingClientRect();
    return {
      buttonCenter: buttonBox.left + buttonBox.width / 2,
      marginCenter: marginBox.left + marginBox.width / 2,
    };
  });
  expect(Math.abs(widePlacement.buttonCenter - widePlacement.marginCenter)).toBeLessThanOrEqual(2);

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
  await resize(page, BREAKPOINT);
  expectOneLine(await rowGeometry(row));
  await expect(photograph).toHaveText('');
  await expectResonanceInMargin(page);

  // On a phone the margin stacks under the page, and resonance goes with it:
  // in the flow, never floating over the writing.
  await resize(page, PHONE);
  expectWritingLayout(await settledFrame(page, WRITING_ORDER));
  expectOneLine(await rowGeometry(row));
  expect(await photograph.getAttribute('aria-label')).toBe(PHOTOGRAPH_NAME);
  await expectResonanceInMargin(page);

  // Reading: Edit takes the camera's slot in the exit row, Promote closes the
  // page under the save hint, and resonance stays in the margin.
  await finish.click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
  for (const size of [PHONE, LAPTOP]) {
    await resize(page, size);
    const edit = exitRow.getByRole('button', { name: EDIT_NAME });
    await expect(edit).toBeVisible();
    await expect(edit).toHaveText('');
    await expect(exitRow.getByTestId('journal-photograph-page')).toHaveCount(0);
    await expect(
      page.getByTestId('journal-read-actions').getByTestId('journal-edit-button'),
    ).toHaveCount(0);
    await expectResonanceInMargin(page);
    const reading = await page.evaluate(() => {
      const box = (id: string) =>
        document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
      const edit = box('journal-edit-button');
      const close = box('journal-close-entry');
      return {
        editRight: edit.right,
        closeLeft: close.left,
        editCentre: edit.top + edit.height / 2,
        closeCentre: close.top + close.height / 2,
        editWidth: edit.width,
        editHeight: edit.height,
        promoteTop: box('promote-quote-button').top,
        hintBottom: box('journal-save-hint').bottom,
        documentScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
    expect(reading.editRight).toBeLessThanOrEqual(reading.closeLeft);
    expect(Math.abs(reading.editCentre - reading.closeCentre)).toBeLessThanOrEqual(
      SAME_LINE_TOLERANCE,
    );
    expect(reading.editWidth).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
    expect(reading.editHeight).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
    expect(reading.promoteTop).toBeGreaterThanOrEqual(reading.hintBottom);
    expect(reading.documentScrollWidth).toBeLessThanOrEqual(reading.innerWidth);
    expectOneLine(await rowGeometry(exitRow));
  }

  // The widest writing row: a reflection adds Sources to the doors, left of the
  // camera, icon-only — and the rail keeps Finish alone and centred.
  setProgramAnchorSixDaysAgo(email);
  await page.getByTestId('journal-close-entry').click();
  await page.reload();
  // The shelf, not the page, is on screen here; the loop below waits on the page.
  await page.setViewportSize(BREAKPOINT);
  await page.getByTestId('journal-reflection-band').click();
  const sources = exitRow.getByRole('button', { name: SOURCES_NAME });
  await expect(sources).toBeVisible();
  await expect(sources).toHaveText('');
  // Finish only appears once the page has words; fill first so the centre
  // check below can never pass against an absent button.
  await page.getByTestId('journal-body-input').fill('What this stage asked of me.');
  await expect(finish).toBeVisible();
  for (const size of [BREAKPOINT, PHONE, NARROW_PHONE]) {
    await resize(page, size);
    await expect(row.getByTestId('reflection-sources-toggle')).toHaveCount(0);
    await expect(row.getByTestId('journal-photograph-page')).toHaveCount(0);
    expectWritingLayout(await settledFrame(page, REFLECTION_ORDER));
    expectOneLine(await rowGeometry(row));
  }
});
