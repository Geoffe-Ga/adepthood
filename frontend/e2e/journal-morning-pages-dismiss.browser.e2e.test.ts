import { expect, test, type Locator, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

/**
 * The morning-pages tip declines with an X in its top-right corner (#2860),
 * measured in a real browser at the app's two viewport profiles.
 *
 * The reported fault was geometric: "Begin a page" sat on the card's content
 * edge and a text "Not now" sat one row lower and `SPACING.md` further right,
 * so the two controls were "aligned with nothing". Jest cannot see that --
 * `jest.config.js` runs the React Native preset under the `node` environment,
 * where `onLayout` never fires and every box is zero (the precedent,
 * `habits-viewport.browser.e2e.test.ts`, says the same of itself). So "aligned"
 * is asserted here as boxes:
 *
 *  1. CORNER -- the X's box is inside the band and flush with its top-right
 *     corner, with a hit area of at least the 44px touch-target floor.
 *  2. CLEAR -- the X intersects neither the "Begin a page" button's box nor
 *     any line of text in the card, so nothing is drawn or tapped under it.
 *  3. ONE EDGE -- the card's text, the "Begin a page" CTA included, shares one
 *     left edge: the only action in the card starts where its words do.
 *
 * It then declines by keyboard and asserts the two things a person feels: the
 * focus lands on the "Start a review early" link rather than on `<body>`, and
 * the tip is still gone after a reload.
 */

/** Bounding boxes are sub-pixel; a fraction of a pixel is not a misalignment. */
const SUBPIXEL_TOLERANCE = 1;
/** The two profiles `habits-viewport.browser.e2e.test.ts` measures; the config pins the wide one. */
const VIEWPORTS = [
  { name: 'narrow', width: 390, height: 844 },
  { name: 'wide', width: 1280, height: 720 },
] as const;
/** `touchTarget.minimum` in `src/design/tokens.ts`: the smallest hit area a control may have. */
const TOUCH_TARGET_MIN = 44;
/** The key the tip's dismissal is persisted under (`src/storage/morningPagesTipStorage.ts`). */
const TIP_DISMISSED_KEY = '@adepthood/morning_pages_tip_dismissed';
const DISMISS_NAME = 'Set the morning-pages tip aside';
/** The card's text runs, top to bottom: label, title, body, CTA. */
const CARD_TEXT = [
  'A practice to try',
  'Morning pages',
  'Twenty minutes of unfiltered writing',
  'Begin a page',
] as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every box the assertions read, taken in ONE layout pass. */
interface CardSnapshot {
  band: Box;
  begin: Box;
  close: Box;
  /** Where the card's words are drawn -- the glyphs, not their padded boxes -- in `CARD_TEXT` order. */
  texts: Box[];
}

/**
 * The card's boxes, all read in the same frame.
 *
 * Reading them one `boundingBox()` at a time is a race: the shelf keeps
 * settling above the card (its entries and prompts load after it), and a
 * box taken before a shift compared with one taken after it measures the
 * shift, not the card -- a first draft of this spec saw the band and its own
 * X 474px apart that way. One `getBoundingClientRect` pass per element inside
 * a single `evaluate` has no gap for layout to move in.
 */
async function snapshotCard(band: Locator): Promise<CardSnapshot> {
  await band.getByRole('button', { name: DISMISS_NAME }).waitFor({ state: 'visible' });
  const snapshot = await band.evaluate(
    (root, { dismissName, texts }) => {
      const rect = (target: Element | Range | null, what: string) => {
        if (target === null) throw new Error(`${what} is not in the band`);
        const { x, y, width, height } = target.getBoundingClientRect();
        return { x, y, width, height };
      };
      /**
       * The drawn extent of the text node holding `text`. A range over the
       * node measures the glyphs themselves, so padding that pushed a run's
       * words off the shared edge shows up here, where its element box would
       * still start at the edge.
       */
      const glyphs = (text: string): Range | null => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if ((node.textContent ?? '').includes(text)) {
            const range = document.createRange();
            range.selectNodeContents(node);
            return range;
          }
        }
        return null;
      };
      return {
        band: rect(root, 'the band'),
        begin: rect(root.querySelector('[data-testid="journal-morning-pages-tip"]'), 'Begin'),
        close: rect(root.querySelector(`[aria-label="${dismissName}"]`), 'the corner X'),
        texts: texts.map((text) => rect(glyphs(text), `the card text "${text}"`)),
      };
    },
    { dismissName: DISMISS_NAME, texts: [...CARD_TEXT] },
  );
  return snapshot;
}

/** Whether two boxes overlap by more than `tolerance` on both axes. */
function intersects(a: Box, b: Box, tolerance: number): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapX > tolerance && overlapY > tolerance;
}

/** One line per control, the shape the issue asks a reviewer to read. */
function describeBox(viewport: string, what: string, box: Box): string {
  const [x, y, w, h] = [box.x, box.y, box.width, box.height].map((n) => Math.round(n));
  return `${viewport}  ${what}  x=${x} y=${y} w=${w} h=${h}`;
}

async function assertCardGeometry(page: Page, viewport: string): Promise<void> {
  const band = page.getByTestId('journal-morning-pages-band');
  const { band: bandBox, begin: beginBox, close: xBox, texts } = await snapshotCard(band);
  console.log(describeBox(viewport, 'journal-morning-pages-band   ', bandBox));
  console.log(describeBox(viewport, 'journal-morning-pages-tip    ', beginBox));
  console.log(describeBox(viewport, 'journal-morning-pages-dismiss', xBox));

  // 1. CORNER: flush with the band's top-right, wholly inside it, 44px or more.
  expect(Math.abs(xBox.x + xBox.width - (bandBox.x + bandBox.width))).toBeLessThanOrEqual(
    SUBPIXEL_TOLERANCE,
  );
  expect(Math.abs(xBox.y - bandBox.y)).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE);
  expect(xBox.x).toBeGreaterThanOrEqual(bandBox.x - SUBPIXEL_TOLERANCE);
  expect(xBox.y + xBox.height).toBeLessThanOrEqual(bandBox.y + bandBox.height + SUBPIXEL_TOLERANCE);
  expect(xBox.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
  expect(xBox.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);

  // 2. CLEAR: no tap on the begin area, and no word of the card, lies under the X.
  expect(intersects(xBox, beginBox, SUBPIXEL_TOLERANCE)).toBe(false);
  for (const box of texts) {
    expect(intersects(xBox, box, SUBPIXEL_TOLERANCE)).toBe(false);
  }

  // 3. ONE EDGE: the CTA's words start where the label's, title's and body's do.
  const [labelBox] = texts;
  if (labelBox === undefined) throw new Error('the card has no text to align against');
  for (const box of texts) {
    expect(Math.abs(box.x - labelBox.x)).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE);
  }
  await expect(band.getByText('Not now', { exact: true })).toHaveCount(0);
}

for (const viewport of VIEWPORTS) {
  test(`at ${viewport.width}x${viewport.height} the morning-pages tip declines with a corner X and hands focus on`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signUp(page, `morning-pages-x-${viewport.name}`);

    await assertCardGeometry(page, `${viewport.width}x${viewport.height}`);

    // Decline by keyboard: the X unmounts with the card, so focus must be handed on.
    await page.getByRole('button', { name: DISMISS_NAME }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('journal-morning-pages-band')).toHaveCount(0);
    await expect(page.getByTestId('journal-review-early')).toBeFocused();

    // Honoured for good: persisted, and still gone once the shelf is rebuilt.
    expect(await page.evaluate((key) => localStorage.getItem(key), TIP_DISMISSED_KEY)).toBe('true');
    await page.reload();
    await expect(page.getByTestId('journal-review-early')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('journal-morning-pages-band')).toHaveCount(0);
  });
}
