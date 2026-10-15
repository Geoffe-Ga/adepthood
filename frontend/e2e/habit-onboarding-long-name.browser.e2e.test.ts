import { expect, test, type Locator, type Page } from '@playwright/test';

import { openHabits, seedHabit, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * #3398: the Energy Scaffolding reorder row clipped a long habit name at its
 * right edge on a phone. The name has to wrap inside the row, at normal and
 * doubled type, without pushing the date or the icon-edit control out of it.
 */
const LONG_NAME =
  'Walk the long way home along the river before the afternoon light fades into evening';
const SUB_PIXEL = 0.5;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface RowGeometry {
  viewport: number;
  scrollWidth: number;
  row: Box;
  name: Box;
  glyphs: Box[];
  date: Box;
  edit: Box;
  energy: Box;
}

/** Drive the onboarding to the reorder step, where each habit is a draggable row. */
async function openReorderStep(page: Page): Promise<Locator> {
  await openHabits(page);
  await page.getByRole('button', { name: 'Start Energy Scaffolding' }).click();
  await page.getByTestId('review-continue').click();
  await page.getByTestId('continue-button').click();
  await page.getByTestId('count-warning-continue').click();
  await page.getByTestId('continue-button').click();
  await page.getByTestId('continue-button').click();
  await expect(page.getByText('Beige begins on:', { exact: true })).toBeVisible();
  const row = page.locator('[data-testid^="reorder-item-"]').filter({ hasText: LONG_NAME });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  return row;
}

/** Double the name's rendered type, leaving the viewport and the row's controls at real size. */
async function enlargeName(row: Locator): Promise<void> {
  await row.getByText(LONG_NAME, { exact: false }).evaluate((node) => {
    const style = getComputedStyle(node);
    node.style.fontSize = `${Number.parseFloat(style.fontSize) * 2}px`;
    const line = Number.parseFloat(style.lineHeight);
    if (Number.isFinite(line)) node.style.lineHeight = `${line * 2}px`;
  });
}

async function measure(row: Locator): Promise<RowGeometry> {
  return row.evaluate((node, name) => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const texts = Array.from(node.querySelectorAll('div[dir="auto"]'));
    const nameNode = texts.find((el) => el.textContent?.includes(name))!;
    const dateNode = texts.find((el) => /^[A-Z][a-z]{2} \d{1,2}$/u.test(el.textContent ?? ''))!;
    const editNode = texts.find((el) => el.textContent === '📝')!.parentElement!;
    const energyNode = texts.find((el) => el.textContent?.startsWith('Cost:'))!;
    const range = document.createRange();
    range.selectNodeContents(nameNode);
    return {
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      row: box(node),
      name: box(nameNode),
      glyphs: Array.from(range.getClientRects()).map((r) => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      })),
      date: box(dateNode),
      edit: box(editNode),
      energy: box(energyNode),
    };
  }, LONG_NAME);
}

function expectInside(inner: Box, outer: Box): void {
  expect(inner.left).toBeGreaterThanOrEqual(outer.left - SUB_PIXEL);
  expect(inner.right).toBeLessThanOrEqual(outer.right + SUB_PIXEL);
  expect(inner.top).toBeGreaterThanOrEqual(outer.top - SUB_PIXEL);
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + SUB_PIXEL);
}

function expectApart(a: Box, b: Box): void {
  expect(
    a.right <= b.left + SUB_PIXEL ||
      b.right <= a.left + SUB_PIXEL ||
      a.bottom <= b.top + SUB_PIXEL ||
      b.bottom <= a.top + SUB_PIXEL,
  ).toBe(true);
}

/** Every glyph of the name sits inside the row and the viewport; the row's controls stay put. */
function assertRow(geometry: RowGeometry): void {
  const viewport = { left: 0, right: geometry.viewport, top: -Infinity, bottom: Infinity };
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
  expectInside(geometry.row, viewport);
  expect(geometry.glyphs.length).toBeGreaterThan(0);
  for (const glyph of geometry.glyphs) {
    expectInside(glyph, geometry.row);
    expectInside(glyph, viewport);
  }
  expectInside(geometry.name, geometry.row);
  expectInside(geometry.date, geometry.row);
  expectInside(geometry.edit, geometry.row);
  expectInside(geometry.energy, geometry.row);
  for (const [a, b] of [
    [geometry.name, geometry.date],
    [geometry.name, geometry.edit],
    [geometry.date, geometry.edit],
    [geometry.energy, geometry.name],
    [geometry.energy, geometry.date],
    [geometry.energy, geometry.edit],
  ] as const) {
    expectApart(a, b);
  }
  // The energy line hangs on the date's left edge: one column rule in the row.
  expect(Math.abs(geometry.energy.left - geometry.date.left)).toBeLessThanOrEqual(SUB_PIXEL);
}

for (const width of [390, 1280]) {
  test(`a long habit name wraps inside its onboarding row at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, 'long-habit-row');
    await seedHabit(request, await tokenFor(request, email), LONG_NAME);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
    const row = await openReorderStep(page);

    const normal = await measure(row);
    await page.screenshot({ path: info.outputPath(`reorder-row-${width}-normal.png`) });
    assertRow(normal);
    await enlargeName(row);
    await row.scrollIntoViewIfNeeded();
    const doubled = await measure(row);
    await page.screenshot({ path: info.outputPath(`reorder-row-${width}-2x.png`) });
    assertRow(doubled);
    // Doubling the name wraps it onto more lines; the controls beside it stay put.
    expect(Math.abs(doubled.edit.right - normal.edit.right)).toBeLessThanOrEqual(SUB_PIXEL);
    expect(Math.abs(doubled.date.left - normal.date.left)).toBeLessThanOrEqual(SUB_PIXEL);
    expect(doubled.glyphs.length).toBeGreaterThan(normal.glyphs.length);
  });
}
