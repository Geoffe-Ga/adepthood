import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * The journal's formatting toolbar: every action on show -- inline styles,
 * line styles (heading, bulleted and numbered lists, quote) and list nesting --
 * on one line that never wraps, scrolling sideways when it outgrows its width. On web a mouse
 * click-and-drag pans the strip, and the release that ends a drag never
 * presses the button it lands on. (A finger swipe is the browser's own
 * overflow scroll, which this does not re-test.)
 */

const ACTIONS = [
  'bold',
  'italic',
  'underline',
  'heading',
  'bullet',
  'ordered',
  'quote',
  'indent',
  'outdent',
] as const;

/** Narrower than the 44px actions, so the strip must overflow. */
const NARROW_STRIP_PX = 120;

async function openFreshPage(page: Page, label: string) {
  await signUp(page, label);
  await page.getByTestId('journal-new-entry').click();
  const field = page.getByTestId('journal-body-input');
  await field.click();
  await page.keyboard.type('plain prose');
  // Typing scrolls the page to the caret; bring the toolbar that leads the body back.
  await page.getByTestId('journal-format-toolbar').scrollIntoViewIfNeeded();
  return field;
}

async function actionTops(page: Page): Promise<number[]> {
  const tops: number[] = [];
  for (const action of ACTIONS) {
    const box = await page.getByTestId(`journal-format-${action}`).boundingBox();
    if (box == null) throw new Error(`journal-format-${action} has no box`);
    tops.push(Math.round(box.y));
  }
  return tops;
}

test('shows every formatting action on one line, list actions disabled on prose', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshPage(page, 'journal-toolbar-all');
  for (const action of ACTIONS) {
    await expect(page.getByTestId(`journal-format-${action}`)).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Indent list item' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Outdent list item' })).toBeDisabled();
  expect(new Set(await actionTops(page)).size).toBe(1);
});

test('an overflowing toolbar stays one line and a mouse drag scrolls it without pressing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const field = await openFreshPage(page, 'journal-toolbar-drag');
  const strip = page.getByTestId('journal-format-toolbar-scroll');
  await strip.evaluate((node, width) => {
    (node as HTMLElement).style.width = `${width}px`;
  }, NARROW_STRIP_PX);

  // Still one line: the overflow scrolls rather than wrapping.
  expect(new Set(await actionTops(page)).size).toBe(1);
  const metrics = () =>
    strip.evaluate((node) => ({
      scrollLeft: (node as HTMLElement).scrollLeft,
      overflow: (node as HTMLElement).scrollWidth - (node as HTMLElement).clientWidth,
    }));
  expect((await metrics()).overflow).toBeGreaterThan(0);

  // Grab the strip over Underline and drag left: the strip follows the mouse.
  const box = await strip.boundingBox();
  if (box == null) throw new Error('toolbar strip has no box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 10, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 10, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await metrics()).scrollLeft).toBeGreaterThan(0);

  // Releasing the drag over a button did not press it: the body is untouched.
  await expect(field).toHaveValue('plain prose');

  // An ordinary click still presses: select a word and bold it.
  await field.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(0, 'plain'.length);
  });
  await strip.evaluate((node) => {
    (node as HTMLElement).scrollLeft = 0;
  });
  await page.getByRole('button', { name: 'Bold' }).click();
  await expect(field).toHaveValue('**plain** prose');
});

/** Select from the start of one line's text to the end of another's. */
async function selectLines(field: Locator, from: string, to = from): Promise<void> {
  await field.evaluate(
    (element, [first, last]) => {
      const area = element as HTMLTextAreaElement;
      const start = area.value.indexOf(first!);
      const end = area.value.indexOf(last!) + last!.length;
      area.focus();
      area.setSelectionRange(start, end);
    },
    [from, to],
  );
}

test('line-style buttons make a heading, lists and a quote that save and render', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const email = await signUp(page, 'journal-toolbar-blocks');
  const token = await tokenFor(page.request, email);
  await page.getByTestId('journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill('Line styles');
  const field = page.getByTestId('journal-body-input');
  await field.click();
  await page.keyboard.type('Plan');
  for (const line of ['milk', 'eggs', 'first', 'second', 'said']) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(line);
  }
  const press = async (name: string) => {
    const button = page.getByRole('button', { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await button.click();
  };

  await selectLines(field, 'said');
  await press('Quote');
  await expect(field).toHaveValue('Plan\nmilk\neggs\nfirst\nsecond\n> said');
  await expect(page.getByTestId('journal-format-quote')).toHaveAttribute('aria-pressed', 'true');

  await selectLines(field, 'first', 'second');
  await press('Numbered list');
  await selectLines(field, 'milk', 'eggs');
  await press('Bulleted list');
  await selectLines(field, 'Plan');
  await press('Heading');
  const message = '# Plan\n- milk\n- eggs\n1. first\n2. second\n> said';
  await expect(field).toHaveValue(message);
  await expect(field).toBeFocused();

  const entryId = ((await (await created).json()) as { id: number }).id;
  await page.getByTestId('journal-finish-button').click();
  const read = page.getByTestId('journal-body-read');
  await expect(read).toBeVisible();
  await expect(read.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible();
  await expect(read.locator('blockquote')).toHaveCount(1);
  await expect(read.locator('[data-testid^="journal-markdown-ordinal-"]')).toHaveCount(2);
  await expect
    .poll(async () => {
      const stored = await page.request.get(`${backendUrl()}/journal/${entryId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return ((await stored.json()) as { message: string }).message;
    })
    .toBe(message);
});
