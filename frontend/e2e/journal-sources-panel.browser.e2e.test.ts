import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  backendUrl,
  setProgramAnchorSixDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * The review composer's Sources panel as navigation (#2883): its heading and X
 * stay put while the feed scrolls, it closes by X, Escape, a backdrop tap (the
 * narrow sheet) and nothing else, focus returns to the Sources toggle, and the
 * writer keeps writing into the same saved entry afterwards. On a wide screen
 * the pane sits BESIDE the writing sheet, never stacked full-width beneath it.
 *
 * Every box is read in ONE evaluate pass, after the layout has held still for
 * a few frames: a stale box is how a press lands on nothing (#2959).
 */

/** Enough finished dailies in the review week that the feed must scroll. */
const SOURCE_COUNT = 12;
/** Lines in each seeded source, so a row expands into a long body. */
const SOURCE_LINES = 30;
/** The platform touch floor (touchTarget.minimum), in CSS px. */
const MIN_TOUCH_TARGET_PX = 44;
/** The narrowest the entry body may get while the panel is open beside it. */
const READABLE_EDITOR_MIN_PX = 480;
/** The writing sheet keeps at least this share of the viewport's height. */
const MIN_EDITOR_HEIGHT_SHARE = 0.6;
/** An expanded source's text is never squeezed narrower than this. */
const SOURCE_TEXT_MIN_PX = 240;
/** The widths the panel is checked at: phone, tablet, laptop, desktop. */
const PROBE_WIDTHS = [390, 768, 1024, 1440] as const;
const PROBE_HEIGHT = 900;
/** The viewport where the pane goes beside the page (the panel's SIDE_PANE_BREAKPOINT). */
const SIDE_PANE_MIN_WIDTH = 1240;
const PHONE = { width: 390, height: 844 } as const;
const LAPTOP = { width: 1280, height: 720 } as const;
/** Sub-pixel rounding allowance on any box comparison. */
const EPSILON_PX = 1;
/** The most Tab presses from the toggle to the panel's close control. */
const MAX_TABS_TO_CLOSE = 12;
/** Consecutive animation frames the layout must hold still before it is measured. */
const SETTLED_FRAMES = 3;
/** The most frames to wait for the layout to come to rest before measuring anyway. */
const MAX_SETTLE_FRAMES = 90;
const DRAFT = 'Looking back on the week.';
const CONTINUED = ' And the river kept going after I closed the sources.';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Seeded {
  headers: Record<string, string>;
  sourceIds: number[];
  reflectionId: number;
}

const visible = (page: Page, testId: string): Locator =>
  page.locator(`[data-testid="${testId}"]:visible`);

const entryBody = (page: Page): Locator => visible(page, 'journal-body-input');

/** Sign up, seed a scrolling week of sources, open the due review and save a draft. */
async function seedReview(page: Page, prefix: string): Promise<Seeded> {
  const email = await signUp(page, prefix);
  const token = await tokenFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  setProgramAnchorSixDaysAgo(email);
  const sourceIds: number[] = [];
  for (let index = 0; index < SOURCE_COUNT; index += 1) {
    const lines = Array.from(
      { length: SOURCE_LINES },
      (_unused, line) => `Day ${index + 1}, line ${line + 1}: I walked beside the river again.`,
    );
    const created = await page.request.post(`${backendUrl()}/journal/`, {
      headers,
      data: { title: `Walk ${index + 1}`, message: lines.join('\n') },
    });
    const id = ((await created.json()) as { id: number }).id;
    await page.request.patch(`${backendUrl()}/journal/${id}`, {
      headers,
      data: { status: 'finished' },
    });
    sourceIds.push(id);
  }
  await page.reload();
  await page.getByTestId('journal-reflection-band').click();
  await entryBody(page).fill(DRAFT);
  await expect(visible(page, 'journal-save-hint')).toHaveText('Saved');
  const reviews = await reviewEntries(page, headers);
  expect(reviews).toHaveLength(1);
  return { headers, sourceIds, reflectionId: reviews[0]!.id };
}

async function reviewEntries(
  page: Page,
  headers: Record<string, string>,
): Promise<Array<{ id: number }>> {
  const listed = await page.request.get(`${backendUrl()}/journal/`, { headers });
  const { items } = (await listed.json()) as {
    items: Array<{ id: number; reflection_scope_key: string | null }>;
  };
  return items.filter((entry) => entry.reflection_scope_key === 'c1:w1');
}

/**
 * Wait until the named elements hold still, then read every box at once. An
 * element whose testID is absent or not rendered reads as null.
 */
async function settledBoxes(page: Page, testIds: string[]): Promise<Record<string, Box | null>> {
  return page.evaluate(
    async ({ ids, settled, maxFrames }) => {
      const read = (): Record<string, Box | null> => {
        const out: Record<string, Box | null> = {};
        for (const id of ids) {
          const match = Array.from(document.querySelectorAll(`[data-testid="${id}"]`)).find(
            (node) => {
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            },
          );
          if (match == null) {
            out[id] = null;
          } else {
            const { x, y, width, height } = match.getBoundingClientRect();
            out[id] = { x, y, width, height };
          }
        }
        return out;
      };
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      let last = JSON.stringify(read());
      let still = 0;
      for (let count = 0; count < maxFrames && still < settled; count += 1) {
        await frame();
        const next = JSON.stringify(read());
        still = next === last ? still + 1 : 0;
        last = next;
      }
      return JSON.parse(last) as Record<string, Box | null>;
    },
    { ids: testIds, settled: SETTLED_FRAMES, maxFrames: MAX_SETTLE_FRAMES },
  );
}

/** Scroll the panel's feed to its top or its end; returns the resulting scrollTop. */
async function scrollFeed(page: Page, to: 'top' | 'end'): Promise<number> {
  return visible(page, 'reflection-sources-scroll').evaluate((node, where) => {
    const scroller = node as HTMLElement;
    scroller.scrollTop = where === 'end' ? scroller.scrollHeight : 0;
    return scroller.scrollTop;
  }, to);
}

function expectInside(inner: Box | null, outer: Box | null): void {
  expect(inner).not.toBeNull();
  expect(outer).not.toBeNull();
  expect(inner!.x).toBeGreaterThanOrEqual(outer!.x - EPSILON_PX);
  expect(inner!.y).toBeGreaterThanOrEqual(outer!.y - EPSILON_PX);
  expect(inner!.x + inner!.width).toBeLessThanOrEqual(outer!.x + outer!.width + EPSILON_PX);
  expect(inner!.y + inner!.height).toBeLessThanOrEqual(outer!.y + outer!.height + EPSILON_PX);
}

function viewportBox(page: Page): Box {
  const size = page.viewportSize();
  if (size == null) throw new Error('no viewport');
  return { x: 0, y: 0, width: size.width, height: size.height };
}

/** The panel's frame testID at the current viewport width. */
function frameId(page: Page): string {
  return viewportBox(page).width >= SIDE_PANE_MIN_WIDTH
    ? 'reflection-sources-pane'
    : 'reflection-sources-sheet-body';
}

async function openSources(page: Page): Promise<void> {
  await visible(page, 'reflection-sources-toggle').click();
  await expect(visible(page, frameId(page))).toBeVisible();
  if (frameId(page) === 'reflection-sources-sheet-body') {
    // react-native-web makes a Modal active -- role "dialog", listening for
    // Escape -- only once its slide-in has ended.
    await expect(page.getByRole('dialog')).toBeVisible();
  }
}

/** Scrolled to the end of a feed that really scrolls, the X is still in view and in the frame. */
async function expectCloseHeldThroughScroll(page: Page): Promise<void> {
  const frame = frameId(page);
  const top = await settledBoxes(page, ['reflection-sources-close', frame]);
  expectInside(top['reflection-sources-close']!, viewportBox(page));
  expectInside(top['reflection-sources-close']!, top[frame]!);
  expect(await scrollFeed(page, 'end')).toBeGreaterThan(0);
  const end = await settledBoxes(page, ['reflection-sources-close', frame]);
  expectInside(end['reflection-sources-close']!, viewportBox(page));
  expectInside(end['reflection-sources-close']!, end[frame]!);
  expect(end['reflection-sources-close']).toEqual(top['reflection-sources-close']);
}

test.describe('phone, 390x844', () => {
  test.use({ viewport: PHONE });

  test('the X stays in reach through a deep scroll, and closing keeps the same entry writing', async ({
    page,
  }) => {
    const seeded = await seedReview(page, 'sources-panel-phone');
    await openSources(page);
    await expect(visible(page, 'reflection-sources-sheet')).toHaveCount(1);
    await expectCloseHeldThroughScroll(page);
    const { 'reflection-sources-close': close } = await settledBoxes(page, [
      'reflection-sources-close',
    ]);
    expect(close!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(close!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(visible(page, 'reflection-sources-sheet-body')).toHaveCount(0);
    await expect(visible(page, 'reflection-sources-toggle')).toBeFocused();

    await entryBody(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(CONTINUED);
    await expect(entryBody(page)).toHaveValue(`${DRAFT}${CONTINUED}`);
    await expect(visible(page, 'journal-save-hint')).toHaveText('Saved');
    const reviews = await reviewEntries(page, seeded.headers);
    expect(reviews.map((entry) => entry.id)).toEqual([seeded.reflectionId]);
    const saved = await page.request.get(`${backendUrl()}/journal/${seeded.reflectionId}`, {
      headers: seeded.headers,
    });
    expect(((await saved.json()) as { message: string }).message).toBe(`${DRAFT}${CONTINUED}`);

    // Escape closes only the sheet.
    await openSources(page);
    await page.keyboard.press('Escape');
    await expect(visible(page, 'reflection-sources-sheet-body')).toHaveCount(0);
    await expect(visible(page, 'journal-screen')).toBeVisible();
    await expect(entryBody(page)).toHaveValue(`${DRAFT}${CONTINUED}`);

    // So does a tap on the backdrop above the sheet -- and a tap inside it does not.
    await openSources(page);
    const boxes = await settledBoxes(page, ['reflection-sources-sheet-body']);
    const sheet = boxes['reflection-sources-sheet-body']!;
    expect(sheet.y).toBeGreaterThan(0);
    await page.mouse.click(sheet.x + sheet.width / 2, sheet.y + sheet.height / 2);
    await expect(visible(page, 'reflection-sources-sheet-body')).toBeVisible();
    await page.mouse.click(PHONE.width / 2, sheet.y / 2);
    await expect(visible(page, 'reflection-sources-sheet-body')).toHaveCount(0);
    await expect(entryBody(page)).toHaveValue(`${DRAFT}${CONTINUED}`);
  });
});

test.describe('laptop, 1280x720', () => {
  test.use({ viewport: LAPTOP });

  test('the pane sits beside the writing sheet and leaves the editor readable', async ({
    page,
  }) => {
    await seedReview(page, 'sources-panel-laptop');
    await openSources(page);
    const boxes = await settledBoxes(page, [
      'reflection-sources-pane',
      'journal-sheet',
      'journal-body-input',
    ]);
    const pane = boxes['reflection-sources-pane']!;
    const sheet = boxes['journal-sheet']!;
    expect(pane.x).toBeGreaterThanOrEqual(sheet.x + sheet.width - EPSILON_PX);
    expect(pane.width).toBeLessThan(LAPTOP.width);
    expect(pane.y).toBeLessThan(sheet.y + sheet.height);
    expect(boxes['journal-body-input']!.width).toBeGreaterThanOrEqual(READABLE_EDITOR_MIN_PX);
    expect(sheet.height).toBeGreaterThanOrEqual(MIN_EDITOR_HEIGHT_SHARE * LAPTOP.height);

    // The heading comes first to a screen reader: before any row of the feed.
    const headingFirst = await visible(page, 'reflection-sources-pane').evaluate((node) => {
      const heading = node.querySelector('[data-testid="reflection-sources-heading"]');
      const row = node.querySelector('[data-testid^="entry-source-"]');
      return (
        heading != null &&
        row != null &&
        (heading.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      );
    });
    expect(headingFirst).toBe(true);

    await expectCloseHeldThroughScroll(page);

    await page.keyboard.press('Escape');
    await expect(visible(page, 'reflection-sources-pane')).toHaveCount(0);
    await expect(visible(page, 'reflection-sources-toggle')).toBeFocused();
    await expect(entryBody(page)).toHaveValue(DRAFT);
  });

  test('the keyboard reaches the close control from the Sources toggle', async ({ page }) => {
    await seedReview(page, 'sources-panel-keyboard');
    const toggle = visible(page, 'reflection-sources-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(visible(page, 'reflection-sources-pane')).toBeVisible();
    let reached = false;
    for (let press = 0; press < MAX_TABS_TO_CLOSE && !reached; press += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') === 'reflection-sources-close',
      );
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');
    await expect(visible(page, 'reflection-sources-pane')).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });
});

test('at every probe width: no overflow, the X in view at both ends, readable text', async ({
  page,
}) => {
  const seeded = await seedReview(page, 'sources-panel-probe');
  const sourceId = seeded.sourceIds[0]!;
  for (const width of PROBE_WIDTHS) {
    await page.setViewportSize({ width, height: PROBE_HEIGHT });
    const before = await settledBoxes(page, ['journal-body-input']);
    await openSources(page);
    await expectCloseHeldThroughScroll(page);
    await scrollFeed(page, 'top');
    await visible(page, `entry-source-${sourceId}`).click();
    const open = await settledBoxes(page, [`source-body-${sourceId}`, 'journal-body-input']);
    expect(open[`source-body-${sourceId}`]!.width).toBeGreaterThanOrEqual(SOURCE_TEXT_MIN_PX);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    if (width >= SIDE_PANE_MIN_WIDTH) {
      expect(open['journal-body-input']!.width).toBeGreaterThanOrEqual(READABLE_EDITOR_MIN_PX);
    }
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(visible(page, frameId(page))).toHaveCount(0);
    const after = await settledBoxes(page, ['journal-body-input']);
    expect(after['journal-body-input']!.width).toBeCloseTo(before['journal-body-input']!.width, 0);
  }
});

for (const viewport of [PHONE, LAPTOP]) {
  test(`selection actions stay inside the panel at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const seeded = await seedReview(page, `sources-panel-select-${viewport.width}`);
    const sourceId = seeded.sourceIds[0]!;
    await openSources(page);
    await visible(page, `entry-source-${sourceId}`).click();
    await visible(page, `source-promote-entry-${sourceId}`).click();
    const prefix = `source-select-entry-${sourceId}`;
    await expect(visible(page, `${prefix}-input`)).toBeFocused();
    const frame = frameId(page);
    const boxes = await settledBoxes(page, [frame, `${prefix}-confirm`, `${prefix}-cancel`]);
    expectInside(boxes[`${prefix}-confirm`]!, boxes[frame]!);
    expectInside(boxes[`${prefix}-cancel`]!, boxes[frame]!);
    expectInside(boxes[`${prefix}-confirm`]!, viewportBox(page));
    await expect(page.getByRole('button', { name: 'Promote selection' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel promoting' })).toBeVisible();
  });
}
