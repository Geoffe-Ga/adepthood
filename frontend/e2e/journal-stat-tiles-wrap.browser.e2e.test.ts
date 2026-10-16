import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

/**
 * #3440: on a 390px phone at 200% browser zoom (195x422 CSS px at device scale
 * 2), the Journal home's stat tiles sat two-up in a row too narrow for their
 * words, so the browser split them mid-word ("habit / s yet"). Lines may break
 * only at spaces, at every width and text size.
 *
 * Each word of every tile's title, stat and cue is measured with a Range: all
 * of that word's client rects must share one line top. The same measurement is
 * swept over every visible text node on the Journal home and in the
 * Notification Center (which hosts the same tiles), so a sibling row that
 * splits words is caught too, not only the reported sample. At 1280px the
 * tiles stay two-up, side by side on one line.
 */

const PHONE = { width: 390, height: 844 } as const;
const LAPTOP = { width: 1280, height: 800 } as const;
/** 200% browser zoom: half the CSS viewport at twice the device pixels. */
const ZOOM_200 = 2;
/** Two rect tops further apart than this sit on different lines. */
const LINE_TOLERANCE = 1;
const SUB_PIXEL = 0.5;
const TILE_IDS = ['journal-habits-tile', 'journal-practices-tile'] as const;
const ROW_ID = 'journal-stat-tile-row';
/** The stack keeps both screens mounted, so every read is scoped to one of them. */
const HOME = '[data-testid="journal-shelf-list"]';
const CENTER = '[data-testid="journal-notification-center"]';
const CENTER_DOOR = 'journal-notifications-open';

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface TileFrame {
  viewport: number;
  scrollWidth: number;
  row: Box;
  tiles: Box[];
  /** Every text glyph run inside a tile, so none spills past its tile. */
  glyphsOutside: string[];
}

/** Words split across two lines under `rootSelector`, each as "word (text)". */
async function splitWords(page: Page, rootSelector: string): Promise<string[]> {
  return page.evaluate(
    ({ selector, tolerance }) => {
      const root = document.querySelector(selector);
      if (!root) throw new Error(`missing ${selector}`);
      const split: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        for (const match of text.matchAll(/\S+/gu)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const tops = Array.from(range.getClientRects())
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => r.top);
          if (tops.length > 1 && Math.max(...tops) - Math.min(...tops) > tolerance) {
            split.push(`${match[0]} (${text.trim()})`);
          }
        }
      }
      return split;
    },
    { selector: rootSelector, tolerance: LINE_TOLERANCE },
  );
}

async function tileFrame(page: Page, scope: string): Promise<TileFrame> {
  return page.evaluate(
    ({ root, rowId, tileIds, slack }) => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const byId = (id: string) => {
        const el = document.querySelector(`${root} [data-testid="${id}"]`);
        if (!el) throw new Error(`missing ${id}`);
        return el;
      };
      const glyphsOutside: string[] = [];
      for (const id of tileIds) {
        const tile = byId(id);
        const t = tile.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(tile);
        for (const r of Array.from(range.getClientRects())) {
          if (r.width === 0 || r.height === 0) continue;
          if (
            r.left < t.left - slack ||
            r.right > t.right + slack ||
            r.top < t.top - slack ||
            r.bottom > t.bottom + slack
          ) {
            glyphsOutside.push(id);
          }
        }
      }
      return {
        viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        row: box(byId(rowId)),
        tiles: tileIds.map((id) => box(byId(id))),
        glyphsOutside,
      };
    },
    { root: scope, rowId: ROW_ID, tileIds: [...TILE_IDS], slack: SUB_PIXEL },
  );
}

/** Double the tiles' rendered type, leaving the viewport and everything else at real size. */
async function doubleTileText(page: Page): Promise<void> {
  await page
    .locator(HOME)
    .getByTestId(ROW_ID)
    .evaluate((row) => {
      for (const el of Array.from(row.querySelectorAll<HTMLElement>('div[dir="auto"]'))) {
        const style = getComputedStyle(el);
        el.style.fontSize = `${Number.parseFloat(style.fontSize) * 2}px`;
        const line = Number.parseFloat(style.lineHeight);
        if (Number.isFinite(line)) el.style.lineHeight = `${line * 2}px`;
      }
    });
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

/** The tiles have loaded their real counts: no skeleton is standing in for a stat. */
async function waitForTiles(page: Page, scope: string): Promise<void> {
  const root = page.locator(scope);
  await expect(root.getByTestId(ROW_ID)).toBeVisible();
  await expect(root.getByTestId('journal-habits-tile')).toContainText('No habits yet');
  await expect(root.getByTestId('journal-practices-tile')).toContainText('this week');
}

/** No tile glyph spills out of its tile, the row stays on screen, nothing scrolls sideways. */
function expectTilesHold(frame: TileFrame): void {
  expect(frame.scrollWidth).toBeLessThanOrEqual(frame.viewport);
  expect(frame.glyphsOutside).toEqual([]);
  expect(frame.row.left).toBeGreaterThanOrEqual(-SUB_PIXEL);
  expect(frame.row.right).toBeLessThanOrEqual(frame.viewport + SUB_PIXEL);
  for (const tile of frame.tiles) {
    expect(tile.left).toBeGreaterThanOrEqual(frame.row.left - SUB_PIXEL);
    expect(tile.right).toBeLessThanOrEqual(frame.row.right + SUB_PIXEL);
  }
}

/** Sign up at `viewport` scaled by `zoom`, and land on the Journal home with live tiles. */
async function openHome(
  browser: Browser,
  viewport: { width: number; height: number },
  zoom: number,
  label: string,
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: viewport.width / zoom, height: viewport.height / zoom },
    deviceScaleFactor: zoom,
  });
  const page = await context.newPage();
  await signUp(page, `stat-tiles-${label}`);
  await waitForTiles(page, HOME);
  return page;
}

for (const [label, viewport] of [
  ['390', PHONE],
  ['1280', LAPTOP],
] as const) {
  test(`journal stat tiles break lines only at spaces at ${label}px, normal and 200% zoom`, async ({
    browser,
  }, testInfo) => {
    for (const zoom of [1, ZOOM_200]) {
      const mode = zoom === 1 ? 'normal' : 'zoom200';
      const page = await openHome(browser, viewport, zoom, `${label}-${mode}`);
      try {
        await page.locator(HOME).getByTestId(ROW_ID).scrollIntoViewIfNeeded();
        await capture(page, testInfo, `home-${label}-${mode}`);
        expect.soft(await splitWords(page, `${HOME} [data-testid="${ROW_ID}"]`), mode).toEqual([]);
        expectTilesHold(await tileFrame(page, HOME));
        // The sweep: no other row on the Journal home splits a word either.
        expect.soft(await splitWords(page, HOME), `home sweep ${mode}`).toEqual([]);

        if (label === '1280' && zoom === 1) {
          // The desktop layout is unchanged: two tiles side by side on one line.
          const [habits, practices] = (await tileFrame(page, HOME)).tiles;
          expect(Math.abs(habits!.top - practices!.top)).toBeLessThanOrEqual(SUB_PIXEL);
          expect(Math.abs(habits!.bottom - practices!.bottom)).toBeLessThanOrEqual(SUB_PIXEL);
          expect(habits!.right).toBeLessThanOrEqual(practices!.left);
        }

        // The same tiles in the Notification Center hold as well.
        await page.getByTestId(CENTER_DOOR).click();
        await waitForTiles(page, CENTER);
        await capture(page, testInfo, `center-${label}-${mode}`);
        expect.soft(await splitWords(page, CENTER), `center sweep ${mode}`).toEqual([]);
        expectTilesHold(await tileFrame(page, CENTER));
      } finally {
        await page.context().close();
      }
    }
  });
}

test('journal stat tiles break lines only at spaces at 390px with doubled text', async ({
  browser,
}, testInfo) => {
  const page = await openHome(browser, PHONE, 1, '390-doubled');
  try {
    await doubleTileText(page);
    await page.locator(HOME).getByTestId(ROW_ID).scrollIntoViewIfNeeded();
    await capture(page, testInfo, 'home-390-doubled');
    expect(await splitWords(page, `${HOME} [data-testid="${ROW_ID}"]`)).toEqual([]);
    expectTilesHold(await tileFrame(page, HOME));
  } finally {
    await page.context().close();
  }
});
