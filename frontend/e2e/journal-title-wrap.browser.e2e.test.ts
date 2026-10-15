import { expect, test, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

/**
 * A wrapped writing title shows every one of its lines (#3325).
 *
 * The title is a growing multiline field: it takes its text's height, so a
 * title too long for one line wraps onto more lines in the page flow, never
 * into a hidden inner scroll. These specs read the real rendered text: the
 * title's value is laid out in a twin of the field with the field's computed
 * face, width and inset, and every line box of that text must sit inside the
 * field's visible padding box, with nothing left to scroll.
 */

/** The title the clipping was first seen with (PR #3323): kept verbatim. */
const ORIGINAL_TITLE = 'A page with steady controls';
/** A title long enough to wrap at every width this spec visits. */
const LONG_TITLE =
  'A long morning page about the steady return of attention, the slow work of coming back, ' +
  'and the quiet promise to keep showing up for the writing';
const LAPTOP = { width: 1280, height: 720 } as const;
const BREAKPOINT_WIDTH = 600;
const PHONE = { width: 390, height: 844 } as const;
/** 200% browser zoom on a 390px phone: the web's own enlarged-text path. */
const PHONE_AT_200 = { width: 195, height: 422 } as const;
/** Sub-pixel rounding allowance between a line box and the field's edge. */
const EDGE_TOLERANCE = 1;

/** One settled read of the title field against its own rendered text. */
interface TitleFit {
  value: string;
  /** Distinct line boxes the value wraps onto at the field's current width. */
  lineCount: number;
  /** The highest and lowest glyph line edge, from the field's top border edge. */
  glyphTop: number;
  glyphBottom: number;
  /** The field's visible padding box, from its top border edge. */
  visibleTop: number;
  visibleBottom: number;
  /** The rendered line height, to bound the field from above as well. */
  lineHeight: number;
  paddingBlock: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  fieldBottom: number;
  /** The top of whatever follows the title in the page (the hairline). */
  nextTop: number;
}

/**
 * Read the title's fit after two animation frames, so a measurement React
 * Native Web is still committing cannot split the reads across two layouts.
 */
async function readTitleFit(page: Page): Promise<TitleFit> {
  const title = page.locator('[data-testid="journal-title-input"]:visible');
  return title.evaluate(async (node) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const field = node as HTMLTextAreaElement;
    const style = getComputedStyle(field);
    const box = field.getBoundingClientRect();
    // A twin with the field's computed face, width and inset lays the value
    // out exactly as the textarea wraps it, and exposes its line boxes.
    const twin = document.createElement('div');
    for (const property of [
      'box-sizing',
      'font-family',
      'font-size',
      'font-style',
      'font-weight',
      'letter-spacing',
      'line-height',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
      'border-top-style',
      'border-right-style',
      'border-bottom-style',
      'border-left-style',
      'text-indent',
      'text-transform',
      'word-spacing',
      'white-space',
      'overflow-wrap',
      'word-break',
    ]) {
      twin.style.setProperty(property, style.getPropertyValue(property));
    }
    twin.style.position = 'absolute';
    twin.style.visibility = 'hidden';
    twin.style.left = '0px';
    twin.style.top = '0px';
    twin.style.width = `${box.width}px`;
    twin.textContent = field.value;
    document.body.append(twin);
    const range = document.createRange();
    range.selectNodeContents(twin);
    const twinTop = twin.getBoundingClientRect().top;
    const lines = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
    const tops = new Set(lines.map((rect) => Math.round(rect.top)));
    const glyphTop = Math.min(...lines.map((rect) => rect.top)) - twinTop;
    const glyphBottom = Math.max(...lines.map((rect) => rect.bottom)) - twinTop;
    twin.remove();
    const hairline = field.nextElementSibling ?? field.parentElement?.nextElementSibling;
    return {
      value: field.value,
      lineCount: tops.size,
      glyphTop,
      glyphBottom,
      visibleTop: field.clientTop,
      visibleBottom: field.clientTop + field.clientHeight,
      lineHeight: parseFloat(style.lineHeight),
      paddingBlock: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
      scrollHeight: field.scrollHeight,
      clientHeight: field.clientHeight,
      scrollTop: field.scrollTop,
      fieldBottom: box.bottom,
      nextTop: hairline instanceof HTMLElement ? hairline.getBoundingClientRect().top : box.bottom,
    };
  });
}

/**
 * Every line of the title is inside the field: no glyph below its visible
 * edge, nothing left in an inner scroll, nothing under the next element, and
 * no slack beyond a line's worth of the field's own inset.
 */
async function expectTitleFits(page: Page, expected: string, minLines: number): Promise<void> {
  const fit = await readTitleFit(page);
  expect(fit.value).toBe(expected);
  expect(fit.lineCount).toBeGreaterThanOrEqual(minLines);
  expect(fit.glyphTop, 'the first title line starts inside the field').toBeGreaterThanOrEqual(
    fit.visibleTop - EDGE_TOLERANCE,
  );
  expect(fit.glyphBottom, 'the last title line ends inside the field').toBeLessThanOrEqual(
    fit.visibleBottom + EDGE_TOLERANCE,
  );
  expect(fit.scrollHeight, 'no title line hides in an inner scroll').toBeLessThanOrEqual(
    fit.clientHeight + EDGE_TOLERANCE,
  );
  expect(fit.scrollTop).toBe(0);
  expect(fit.fieldBottom, 'the title never runs under the page below it').toBeLessThanOrEqual(
    fit.nextTop + EDGE_TOLERANCE,
  );
  // Sized to its text, not grown-only: a widened page gives the space back.
  expect(fit.clientHeight).toBeLessThanOrEqual(
    fit.lineCount * fit.lineHeight + fit.paddingBlock + EDGE_TOLERANCE,
  );
}

/** Resize and wait for the product's own breakpoint to answer, not just the call. */
async function resize(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  // A reopened entry's page stacks over the closed one's; only the visible one answers.
  await expect(page.locator('[data-testid="journal-page"]:visible')).toHaveCSS(
    'flex-direction',
    size.width < BREAKPOINT_WIDTH ? 'column' : 'row',
  );
}

test('a wrapped writing title shows every line when typed, edited, resized and reloaded', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(LAPTOP);
  await signUp(page, 'journal-title-wrap');
  await page.getByTestId('journal-new-entry').click();
  const title = page.getByTestId('journal-title-input');
  const body = page.getByTestId('journal-body-input');

  // The original report: the unchanged title, set on a wide page, then a phone.
  await title.fill(ORIGINAL_TITLE);
  await body.fill('The controls should stay where the writer can find them.');
  await expectTitleFits(page, ORIGINAL_TITLE, 1);
  await resize(page, PHONE);
  await page.screenshot({ path: testInfo.outputPath('title-original-390.png') });
  await expectTitleFits(page, ORIGINAL_TITLE, 2);

  // Fresh typing at phone width: real keystrokes, one line becoming several.
  await title.fill('');
  await title.pressSequentially(LONG_TITLE);
  await expectTitleFits(page, LONG_TITLE, 3);
  await page.screenshot({ path: testInfo.outputPath('title-typed-390.png') });

  // Widened, the title gives back the lines it no longer needs.
  await resize(page, LAPTOP);
  await expectTitleFits(page, LONG_TITLE, 2);
  await page.screenshot({ path: testInfo.outputPath('title-typed-1280.png') });

  // Editing in place keeps every line visible; Enter still moves to the body.
  const edited = `${LONG_TITLE}, again`;
  await resize(page, PHONE);
  await title.press('End');
  await title.pressSequentially(', again');
  await expectTitleFits(page, edited, 3);
  await title.press('Enter');
  await expect(body).toBeFocused();
  await expect(title).toHaveValue(edited);

  // Saved and reopened, the loaded title wraps fully at both widths.
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-close-entry').click();
  const entryId = ((await (await created).json()) as { id: number; title: string }).id;
  const saved = page.getByTestId(`journal-shelf-open-${entryId}`);
  await expect(saved).toContainText(edited);
  await saved.click();
  await expect(page.locator('[data-testid="journal-title-input"]:visible')).toHaveValue(edited);
  await expectTitleFits(page, edited, 3);
  await page.screenshot({ path: testInfo.outputPath('title-loaded-390.png') });
  await resize(page, LAPTOP);
  await expectTitleFits(page, edited, 2);
});

test('a wrapped writing title shows every line at 200% browser zoom on a phone', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ viewport: PHONE_AT_200, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await signUp(page, 'journal-title-wrap-zoom');
    await page.getByTestId('journal-new-entry').click();
    const title = page.getByTestId('journal-title-input');
    await title.pressSequentially(ORIGINAL_TITLE);
    await expectTitleFits(page, ORIGINAL_TITLE, 2);
    await title.fill(LONG_TITLE);
    await expectTitleFits(page, LONG_TITLE, 4);
    await page.screenshot({ path: testInfo.outputPath('title-zoom-200.png') });
  } finally {
    await context.close();
  }
});
