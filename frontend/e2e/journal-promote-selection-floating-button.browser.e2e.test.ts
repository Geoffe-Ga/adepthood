import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  backendUrl,
  bearer,
  openPrompts,
  setProgramAnchorSixDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * The floating "Promote selection" pill in a review's Sources (#3134).
 *
 * A writer reviewing a week opens a long source, chooses Promote a quote, and
 * highlights a sentence far down it. The pill comes to the selection -- in the
 * bounded bottom sheet on a phone and the centred modal on a laptop -- floating
 * centred over the source's column, its lift above the foot of the panel's
 * scroll, never doubled by a Promote in the footer. Its X clears the
 * selection without leaving selection mode; a pointer press at the pill's
 * place on screen promotes the next sentence over the real route, and the
 * quote joins the panel's Quotes to fold in. Journal read mode's own long
 * entry is driven by journal-promote-quote-long-entry.browser.e2e.test.ts.
 */

const PHONE = { width: 390, height: 844 } as const;
const LAPTOP = { width: 1280, height: 720 } as const;
/** Lines in the long source: comfortably more than DEEP_OFFSET_PX of text. */
const SOURCE_LINES = 120;
/** How far down the source the promoted sentence lies (#3134). */
const DEEP_OFFSET_PX = 2000;
/**
 * ``RESONANCE_BUTTON_CLEARANCE`` (SPACING.xl + touchTarget.minimum + SPACING.md):
 * the floating pill's lift above the foot of the scroll viewport.
 */
const FLOATING_LIFT_PX = 76;
/** The platform touch floor (touchTarget.minimum), in CSS px. */
const MIN_TOUCH_TARGET_PX = 44;
/** Sub-pixel rounding allowance on a box comparison. */
const EPSILON_PX = 1;
/** Keeps a drag's ends inside the line's glyphs rather than on the field's padding. */
const DRAG_INSET_PX = 4;
const DRAG_STEPS = 12;
const HALF = 2;
const FAB = 'promote-selection-fab';
const DRAFT = 'Looking back on the week.';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LineGeometry {
  left: number;
  right: number;
  /** Client y of the top of the field's first line of text. */
  firstLineTop: number;
  lineHeight: number;
}

const visible = (page: Page, testId: string): Locator =>
  page.locator(`[data-testid="${testId}"]:visible`);

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('expected a laid-out element');
  return box;
}

function lineGeometry(field: Locator): Promise<LineGeometry> {
  return field.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left:
        rect.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
      right:
        rect.right -
        Number.parseFloat(style.borderRightWidth) -
        Number.parseFloat(style.paddingRight),
      firstLineTop:
        rect.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop),
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  });
}

/** Sign up, seed one long finished source in the review week, and open the review's Sources. */
async function openLongSource(
  page: Page,
  prefix: string,
): Promise<{ headers: Record<string, string>; sourceId: number; lines: string[] }> {
  const email = await signUp(page, prefix);
  const headers = bearer(await tokenFor(page.request, email));
  setProgramAnchorSixDaysAgo(email);
  const lines = Array.from(
    { length: SOURCE_LINES },
    (_unused, index) => `Line ${index + 1}: I walked beside the river.`,
  );
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: 'A long walk', message: lines.join('\n') },
  });
  expect(created.ok()).toBe(true);
  const sourceId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${sourceId}`, {
    headers,
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);
  await page.reload();
  await openPrompts(page);
  await page.getByTestId('journal-reflection-band').click();
  await visible(page, 'journal-body-input').fill(DRAFT);
  await expect(visible(page, 'journal-save-hint')).toHaveText('Saved');
  await visible(page, 'reflection-sources-toggle').click();
  await visible(page, `entry-source-${sourceId}`).click();
  await visible(page, `source-promote-entry-${sourceId}`).click();
  await expect(visible(page, `source-select-entry-${sourceId}-input`)).toBeFocused();
  return { headers, sourceId, lines };
}

/** Bring line ``index`` of the field to the middle of the panel's scroll, then drag across it. */
async function selectLine(page: Page, field: Locator, index: number): Promise<void> {
  const scroller = visible(page, 'reflection-sources-scroll');
  const frame = await boxOf(scroller);
  const before = await lineGeometry(field);
  await scroller.evaluate(
    (element, delta) => element.scrollBy(0, delta),
    before.firstLineTop + index * before.lineHeight - (frame.y + frame.height / HALF),
  );
  const line = await lineGeometry(field);
  const y = line.firstLineTop + index * line.lineHeight + line.lineHeight / HALF;
  expect(y).toBeGreaterThan(frame.y);
  expect(y).toBeLessThan(frame.y + frame.height);
  await page.mouse.move(line.left + DRAG_INSET_PX, y);
  await page.mouse.down();
  await page.mouse.move(line.right - DRAG_INSET_PX, y, { steps: DRAG_STEPS });
  await page.mouse.up();
}

/**
 * Wait for the pill's arrival to finish -- its fade and settle share one
 * progress, so full opacity means it has also settled -- before measuring it.
 */
async function pillAtRest(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.getByTestId(`${FAB}-anchor`).evaluate((node) => getComputedStyle(node).opacity),
    )
    .toBe('1');
}

/** The pill and its X sit inside the panel's scroll viewport, centred over the column, lifted. */
async function expectPillPlaced(page: Page, field: Locator): Promise<Box> {
  const fab = page.getByTestId(FAB);
  await expect(fab).toBeInViewport();
  await pillAtRest(page);
  const pill = await boxOf(fab);
  const clear = await boxOf(page.getByTestId(`${FAB}-cancel`));
  const column = await boxOf(field);
  const scroll = await boxOf(visible(page, 'reflection-sources-scroll'));
  const groupCentre = (pill.x + clear.x + clear.width) / HALF;
  expect(Math.abs(groupCentre - (column.x + column.width / HALF))).toBeLessThanOrEqual(EPSILON_PX);
  const groupBottom = Math.max(pill.y + pill.height, clear.y + clear.height);
  expect(Math.abs(scroll.y + scroll.height - groupBottom - FLOATING_LIFT_PX)).toBeLessThanOrEqual(
    EPSILON_PX,
  );
  expect(pill.x).toBeGreaterThanOrEqual(scroll.x);
  expect(clear.x + clear.width).toBeLessThanOrEqual(scroll.x + scroll.width);
  expect(pill.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  expect(clear.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  expect(clear.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  // The one primary on screen: the footer never draws a second Promote.
  await expect(page.getByRole('button', { name: 'Promote selection' })).toHaveCount(1);
  return pill;
}

for (const viewport of [PHONE, LAPTOP]) {
  test(`at ${viewport.width}x${viewport.height} the floating pill promotes a sentence 2000px down a source without scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { headers, sourceId, lines } = await openLongSource(
      page,
      `floating-promote-${viewport.width}`,
    );
    const prefix = `source-select-entry-${sourceId}`;
    const field = visible(page, `${prefix}-input`);
    await expect(page.getByRole('button', { name: 'Promote selection' })).toHaveCount(0);

    const { lineHeight } = await lineGeometry(field);
    const deep = Math.ceil(DEEP_OFFSET_PX / lineHeight);
    expect(deep * lineHeight).toBeGreaterThanOrEqual(DEEP_OFFSET_PX);

    // The X clears the selection and the pill goes with it; the reader stays selecting.
    await selectLine(page, field, deep);
    await expectPillPlaced(page, field);
    await page.getByTestId(`${FAB}-cancel`).click();
    await expect(page.getByTestId(FAB)).toHaveCount(0);
    await expect(visible(page, `${prefix}-preview`)).toHaveCount(0);
    await expect(field).toBeFocused();

    // The next sentence down, promoted by a press at the pill's place on screen:
    // no scroll stands between the selection and its promotion.
    const target = deep + 1;
    await selectLine(page, field, target);
    const preview = visible(page, `${prefix}-preview`);
    await expect(preview).toContainText(`Line ${target + 1}:`);
    const selectedText = (await preview.textContent())?.trim() ?? '';
    expect(lines[target]?.includes(selectedText)).toBe(true);
    const pill = await expectPillPlaced(page, field);
    const promoteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/journal/${sourceId}/promote`,
    );
    const [promoted] = await Promise.all([
      promoteResponse,
      page.mouse.click(pill.x + pill.width / HALF, pill.y + pill.height / HALF),
    ]);
    expect(promoted.ok()).toBe(true);
    const quote = (await promoted.json()) as { id: number; anchor_text: string };
    expect(quote.anchor_text).toBe(selectedText);

    // The surface closes, and the quote waits among the panel's Quotes to fold in.
    await expect(page.getByTestId(FAB)).toHaveCount(0);
    await expect(visible(page, `pending-quote-${quote.id}`)).toContainText(selectedText);
    const stored = await page.request.get(`${backendUrl()}/journal/${sourceId}/promotions`, {
      headers,
    });
    expect(stored.ok()).toBe(true);
    expect(
      ((await stored.json()) as Array<{ anchor_text: string }>).map((q) => q.anchor_text),
    ).toEqual([selectedText]);
  });
}
