import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  backendUrl,
  setProgramAnchorSixDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';
import { openPrompts } from './journalHabitsBrowserSupport';

/**
 * The review composer's Sources panel as navigation (#2883): its heading and X
 * stay put while the feed scrolls, it closes by X, Escape, a backdrop tap and
 * nothing else, focus lands on its X as it opens and returns to the Sources
 * toggle as it closes (#3002), and the writer keeps writing into the same
 * saved entry afterwards. On a phone it is a bottom sheet; on a wide screen a
 * card at the reading measure centred over the dimmed desk (#3133), never a
 * sliver beside the page.
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
/** The narrowest the entry body may get, behind the open panel, on a wide screen. */
const READABLE_EDITOR_MIN_PX = 480;
/** An expanded source's text is never squeezed narrower than this. */
const SOURCE_TEXT_MIN_PX = 240;
/** The widths the panel is checked at: phone, tablet, laptop, desktop. */
const PROBE_WIDTHS = [390, 768, 1024, 1440] as const;
const PROBE_HEIGHT = 900;
/** The viewport where the panel opens as a centred card (the panel's CENTRED_MODAL_BREAKPOINT). */
const CENTRED_MODAL_MIN_WIDTH = 1240;
/** The centred card's width cap: the page's reading measure (journalLayout.pageMaxWidth). */
const READING_MEASURE_PX = 680;
/** The dialog's accessible name. */
const DIALOG_NAME = 'Sources';
const PHONE = { width: 390, height: 844 } as const;
const LAPTOP = { width: 1280, height: 720 } as const;
/** Sub-pixel rounding allowance on any box comparison. */
const EPSILON_PX = 1;
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
  await openPrompts(page);
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
  return viewportBox(page).width >= CENTRED_MODAL_MIN_WIDTH
    ? 'reflection-sources-modal-body'
    : 'reflection-sources-sheet-body';
}

async function openSources(page: Page): Promise<void> {
  await visible(page, 'reflection-sources-toggle').click();
  await expect(visible(page, frameId(page))).toBeVisible();
  // react-native-web makes a Modal active -- role "dialog", listening for
  // Escape -- only once its slide-in (or fade-in) has ended.
  await expect(page.getByRole('dialog', { name: DIALOG_NAME })).toBeVisible();
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
  expect(end['reflection-sources-close']!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  expect(end['reflection-sources-close']!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
}

/**
 * The toggle sits in the exit row, above the editor (#3002), so a Tab walk to
 * the dock would cross the whole page; the panel takes focus on its close as
 * it opens instead, and closing hands focus back to the toggle.
 */
async function expectKeyboardRoundTrip(page: Page, frame: string): Promise<void> {
  const toggle = visible(page, 'reflection-sources-toggle');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(visible(page, frame)).toBeVisible();
  await expect(visible(page, 'reflection-sources-close')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(visible(page, frame)).toHaveCount(0);
  await expect(toggle).toBeFocused();
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
    await expect(visible(page, 'reflection-sources-toggle')).toBeFocused();
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
    await expect(visible(page, 'reflection-sources-toggle')).toBeFocused();
    await expect(entryBody(page)).toHaveValue(`${DRAFT}${CONTINUED}`);
  });
});

test.describe('laptop, 1280x720', () => {
  test.use({ viewport: LAPTOP });

  test('the panel opens as a card centred over the desk at the reading measure', async ({
    page,
  }) => {
    await seedReview(page, 'sources-panel-laptop');
    const closed = await settledBoxes(page, ['journal-sheet']);
    await openSources(page);
    const boxes = await settledBoxes(page, [
      'reflection-sources-modal-body',
      'reflection-sources-scrim',
      'journal-sheet',
    ]);
    const card = boxes['reflection-sources-modal-body']!;
    const viewport = viewportBox(page);
    // Centred on both axes, at the reading measure -- not a sliver at the edge.
    expect(Math.abs(card.x + card.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(EPSILON_PX);
    expect(Math.abs(card.y + card.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(
      EPSILON_PX,
    );
    expect(Math.abs(card.width - Math.min(READING_MEASURE_PX, viewport.width))).toBeLessThanOrEqual(
      EPSILON_PX,
    );
    expectInside(card, viewport);
    // The dimmed desk covers the whole viewport behind it, and the page itself
    // has not moved or shrunk to make room.
    await expect(visible(page, 'reflection-sources-scrim')).toBeVisible();
    expectInside(viewport, boxes['reflection-sources-scrim']!);
    expect(boxes['journal-sheet']).toEqual(closed['journal-sheet']);

    // The heading comes first to a screen reader: before any row of the feed.
    const headingFirst = await visible(page, 'reflection-sources-modal-body').evaluate((node) => {
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

    // Escape closes only the card.
    await page.keyboard.press('Escape');
    await expect(visible(page, 'reflection-sources-modal-body')).toHaveCount(0);
    await expect(visible(page, 'reflection-sources-toggle')).toBeFocused();
    await expect(entryBody(page)).toHaveValue(DRAFT);

    // So does a click on the dimmed desk beside it -- and a click inside it does not.
    await openSources(page);
    const reopened = (await settledBoxes(page, ['reflection-sources-modal-body']))[
      'reflection-sources-modal-body'
    ]!;
    const middleY = reopened.y + reopened.height / 2;
    await page.mouse.click(reopened.x + reopened.width / 2, middleY);
    await expect(visible(page, 'reflection-sources-modal-body')).toBeVisible();
    await page.mouse.click(reopened.x / 2, middleY);
    await expect(visible(page, 'reflection-sources-modal-body')).toHaveCount(0);
    await expect(visible(page, 'reflection-sources-toggle')).toBeFocused();
    await expect(entryBody(page)).toHaveValue(DRAFT);

    // And so does the X.
    await openSources(page);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(visible(page, 'reflection-sources-modal-body')).toHaveCount(0);
    await expect(visible(page, 'reflection-sources-toggle')).toBeFocused();
    await expect(entryBody(page)).toHaveValue(DRAFT);
  });

  test('opening Sources from the keyboard lands focus on the centred card close', async ({
    page,
  }) => {
    await seedReview(page, 'sources-panel-keyboard');
    await expectKeyboardRoundTrip(page, 'reflection-sources-modal-body');
  });
});

test.describe('phone keyboard, 390x844', () => {
  test.use({ viewport: PHONE });

  test('opening Sources from the keyboard lands focus on the sheet close', async ({ page }) => {
    await seedReview(page, 'sources-panel-keyboard-phone');
    await expectKeyboardRoundTrip(page, 'reflection-sources-sheet-body');
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
    if (width >= CENTRED_MODAL_MIN_WIDTH) {
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
    const field = visible(page, `${prefix}-input`);
    await expect(field).toBeFocused();
    const frame = frameId(page);
    // Nothing chosen yet: the way out is in the panel, and no Promote is anywhere.
    const before = await settledBoxes(page, [frame, `${prefix}-cancel`]);
    expectInside(before[`${prefix}-cancel`]!, before[frame]!);
    await expect(page.getByRole('button', { name: 'Cancel promoting' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Promote selection' })).toHaveCount(0);

    // A word chosen: the floating Promote and its X rise inside the panel (#3134).
    await field.dblclick({ position: { x: 40, y: 24 } });
    await expect(page.getByRole('button', { name: 'Promote selection' })).toBeVisible();
    const after = await settledBoxes(page, [
      frame,
      'promote-selection-fab',
      'promote-selection-fab-cancel',
      `${prefix}-cancel`,
    ]);
    expectInside(after['promote-selection-fab']!, after[frame]!);
    expectInside(after['promote-selection-fab-cancel']!, after[frame]!);
    expectInside(after['promote-selection-fab']!, viewportBox(page));
    expectInside(after[`${prefix}-cancel`]!, after[frame]!);
  });
}
