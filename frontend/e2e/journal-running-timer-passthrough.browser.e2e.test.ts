import { expect, test, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

const PHONE = { width: 390, height: 844 } as const;
const LAPTOP = { width: 1280, height: 800 } as const;
/** Sample columns across the band's width, skipping its outermost pixels. */
const SAMPLE_COLUMNS = 24;
/** Sample rows down the band's height. */
const SAMPLE_ROWS = 6;
/** Keep samples off the band's exact edges, where hit-testing is ambiguous. */
const EDGE_INSET = 2;

/** One sampled point the band swallowed instead of passing through. */
interface Swallowed {
  x: number;
  y: number;
  hit: string;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A point in viewport coordinates. */
interface Point {
  x: number;
  y: number;
}

/** The band's and the pill's boxes, read in one task so no re-render falls between them. */
async function bandAndPill(page: Page): Promise<{ band: Rect; pill: Rect }> {
  return page.evaluate(() => {
    const rectOf = (id: string): Rect => {
      const node = document.querySelector(`[data-testid="${id}"]`);
      if (node === null) throw new Error(`${id} is missing`);
      const { left, top, right, bottom } = node.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    return { band: rectOf('writing-session-band'), pill: rectOf('writing-timer-pill') };
  });
}

function inside(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

/** An evenly spaced grid over ``area``, inset from its edges, leaving out ``keep``. */
function samplePoints(area: Rect, keep: Rect): Point[] {
  const width = area.right - area.left - 2 * EDGE_INSET;
  const height = area.bottom - area.top - 2 * EDGE_INSET;
  const points: Point[] = [];
  for (let col = 0; col <= SAMPLE_COLUMNS; col += 1) {
    for (let row = 0; row <= SAMPLE_ROWS; row += 1) {
      points.push({
        x: area.left + EDGE_INSET + (width * col) / SAMPLE_COLUMNS,
        y: area.top + EDGE_INSET + (height * row) / SAMPLE_ROWS,
      });
    }
  }
  return points.filter((point) => !inside(point, keep));
}

/**
 * Every sampled point inside the floating band but outside the visible timer
 * controls that hit-tests into the band rather than the page beneath it (#3694).
 *
 * The band is laid edge to edge so it can place the pill on the trailing side;
 * only the pill (and any standing note) is meant to catch a pointer. On RN Web
 * ``box-none`` makes an element's own box ``pointer-events: none`` but sets its
 * direct children back to ``auto``, so a full-width child that is itself not
 * ``box-none`` becomes an invisible, unclickable strip across the writing.
 */
async function swallowedPoints(page: Page): Promise<Swallowed[]> {
  const { band, pill } = await bandAndPill(page);
  return page.evaluate(
    (points) => {
      const host = document.querySelector('[data-testid="writing-session-band"]');
      if (host === null) throw new Error('writing-session-band is missing');
      const describe = (node: Element): string =>
        `${node.getAttribute('data-testid') ?? node.tagName} in ${
          node.parentElement?.getAttribute('data-testid') ?? 'untagged'
        } (${Math.round(node.getBoundingClientRect().width)}px wide)`;
      return points.flatMap(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        if (hit === null || !host.contains(hit)) return [];
        return [{ x: Math.round(x), y: Math.round(y), hit: describe(hit) }];
      });
    },
    samplePoints(band, pill),
  );
}

for (const [label, viewport] of [
  ['1280x800', LAPTOP],
  ['390x844', PHONE],
] as const) {
  test(`a running timer lets clicks beside it reach the writing at ${label}`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
      await signUp(page, `timer-passthrough-${label}`);
      await page.getByTestId('journal-new-entry').click();
      const body = page.getByTestId('journal-body-input');
      await body.fill(
        Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the writing.`).join('\n'),
      );
      await page.getByTestId('writing-timer-start').click();
      await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`running-timer-${label}.png`) });

      expect(
        await swallowedPoints(page),
        'only the timer itself may catch a pointer inside its floating band',
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
