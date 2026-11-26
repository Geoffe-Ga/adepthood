import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * One list item over two lines: Shift+Return opens a line under the item's
 * text, Return starts the next item, Return again leaves the list -- for a
 * bullet, a numbered item and a checkbox, in the real <textarea>, through the
 * autosave and read routes, and into read mode after a cold reload.
 */

/** How far apart two text starts may be and still count as the same column. */
const SAME_COLUMN_PX = 0.5;

const LISTS = [
  { name: 'bullet', first: '- buy oats', indent: '  ', next: '- ' },
  { name: 'numbered', first: '1. boil water', indent: '   ', next: '2. ' },
  { name: 'checkbox', first: '- [ ] call Sam', indent: '      ', next: '- [ ] ' },
] as const;

async function caret(field: Locator): Promise<number> {
  return field.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    return area.selectionStart === area.selectionEnd ? area.selectionStart : -1;
  });
}

/** The left edge of the first drawn occurrence of ``needle`` inside read mode. */
async function textLeft(page: Page, needle: string): Promise<number> {
  return page.getByTestId('journal-body-read').evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(text);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      return range.getBoundingClientRect().left;
    }
    throw new Error(`read mode does not draw ${text}`);
  }, needle);
}

test('Shift+Return keeps a line inside its item, Return starts the next, Return again leaves the list', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-list-continuation');
  const token = await tokenFor(page.request, email);
  await page.getByTestId('journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill('Lists that run on');
  const field = page.getByTestId('journal-body-input');
  await field.click();

  let message = '';
  for (const list of LISTS) {
    const second = `second line of the ${list.name}`;
    await page.keyboard.type(list.first);

    // Step 1: Shift+Return opens a line with no marker, indented to the item's text.
    await page.keyboard.press('Shift+Enter');
    await expect(field).toHaveValue(`${message}${list.first}\n${list.indent}`);
    expect(await caret(field)).toBe(`${message}${list.first}\n${list.indent}`.length);
    await page.keyboard.type(second);

    // Step 2: Return starts the next item of the same kind.
    await page.keyboard.press('Enter');
    await expect(field).toHaveValue(
      `${message}${list.first}\n${list.indent}${second}\n${list.next}`,
    );

    // Step 3: Return on that empty item leaves the list.
    await page.keyboard.press('Enter');
    message = `${message}${list.first}\n${list.indent}${second}\n`;
    await expect(field).toHaveValue(message);
    expect(await caret(field)).toBe(message.length);
  }

  // Backspace takes a continuation line back in one keystroke.
  await page.keyboard.type('- last');
  await page.keyboard.press('Shift+Enter');
  await expect(field).toHaveValue(`${message}- last\n  `);
  await page.keyboard.press('Backspace');
  message = `${message}- last`;
  await expect(field).toHaveValue(message);

  const entryId = ((await (await created).json()) as { id: number }).id;
  await page.getByTestId('journal-finish-button').click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
  await expect
    .poll(async () => {
      const stored = await page.request.get(`${backendUrl()}/journal/${entryId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return ((await stored.json()) as { message: string }).message;
    })
    .toBe(message);

  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
  // Read mode: each second line belongs to its item -- no marker of its own,
  // and its text starts in the same column as the item's text above it.
  await expect(page.locator('[data-testid^="journal-markdown-continuation-"]')).toHaveCount(3);
  await expect(page.locator('[data-testid^="journal-markdown-ordinal-"]')).toHaveCount(1);
  await expect(page.locator('[data-testid^="journal-markdown-checkbox-"]')).toHaveCount(1);
  for (const [first, second] of [
    ['buy oats', 'second line of the bullet'],
    ['boil water', 'second line of the numbered'],
    ['call Sam', 'second line of the checkbox'],
  ] as const) {
    const itemLeft = await textLeft(page, first);
    expect(Math.abs((await textLeft(page, second)) - itemLeft)).toBeLessThan(SAME_COLUMN_PX);
  }
});

/**
 * A body with every list shape a continuation line can sit under: a bullet, a
 * numbered pair whose markers differ in width (9. / 10.) and a checkbox, each
 * with an item nested one level, and every item running onto a second line.
 */
const ALIGNED_BODY = [
  '- bullet head',
  '  bullet tail',
  '  - nested bullet head',
  '    nested bullet tail',
  '',
  '9. nine head',
  '   nine tail',
  '10. ten head',
  '    ten tail',
  '    1. nested number head',
  '       nested number tail',
  '',
  '- [ ] box head',
  '      box tail',
  '  - [x] nested box head',
  '        nested box tail',
].join('\n');

const ALIGNED_PAIRS = [
  ['bullet head', 'bullet tail'],
  ['nested bullet head', 'nested bullet tail'],
  ['nine head', 'nine tail'],
  ['ten head', 'ten tail'],
  ['nested number head', 'nested number tail'],
  ['box head', 'box tail'],
  ['nested box head', 'nested box tail'],
] as const;

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
] as const;

/**
 * The left edge of each needle's first drawn character in read mode, all read
 * in one pass: a resize re-lays the page out, and edges read one call apart
 * could come from two different layouts.
 */
async function textLefts(page: Page, needles: readonly string[]): Promise<Record<string, number>> {
  return page.getByTestId('journal-body-read').evaluate((root, texts) => {
    const lefts: Record<string, number> = {};
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      for (const text of texts) {
        const at = (node.textContent ?? '').indexOf(text);
        if (at === -1 || text in lefts) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        lefts[text] = range.getBoundingClientRect().left;
      }
    }
    return lefts;
  }, needles);
}

test('read mode starts every continuation line on its item’s text column, phone and desktop', async ({
  page,
}) => {
  await signUp(page, 'journal-list-continuation-columns');
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-title-input').fill('Columns');
  await page.getByTestId('journal-body-input').fill(ALIGNED_BODY);
  await page.getByTestId('journal-finish-button').click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
  await expect(page.locator('[data-testid^="journal-markdown-continuation-"]')).toHaveCount(
    ALIGNED_PAIRS.length,
  );

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const lefts = await textLefts(page, ALIGNED_PAIRS.flat());
    for (const [head, tail] of ALIGNED_PAIRS) {
      expect(
        Math.abs(lefts[tail]! - lefts[head]!),
        `${tail} at ${String(viewport.width)}px`,
      ).toBeLessThan(SAME_COLUMN_PX);
    }
    // The 9. / 10. pair shares one text column, and so do their second lines.
    expect(Math.abs(lefts['ten tail']! - lefts['nine tail']!)).toBeLessThan(SAME_COLUMN_PX);
    // A nested item's second line sits to the right of its parent's.
    expect(lefts['nested bullet tail']!).toBeGreaterThan(lefts['bullet tail']! + SAME_COLUMN_PX);
  }
});
