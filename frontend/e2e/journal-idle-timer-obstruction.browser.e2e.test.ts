import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

const PHONE = { width: 390, height: 844 } as const;
const LAPTOP = { width: 1280, height: 800 } as const;
const ZOOM_200 = 2;
const SHORT_PHONE = { width: 390, height: 300 } as const;
const EDGE_TOLERANCE = 1;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator, name: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${name} has no laid-out box`);
  return box;
}

function overlapArea(a: Box, b: Box): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function intersectionBox(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

/** Where the painted-overlap watch keeps every offending frame. */
const OVERLAP_FRAMES = '__idleTimerOverlapFrames';

/** One painted frame in which the timer covered visible writing, rounded for the report. */
interface OverlapFrame {
  area: number;
  timer: number[];
  writing: number[];
}

/**
 * Sample every animation frame, from before the page opens until the idle
 * check ends, for a painted timer covering visible writing (#3481).
 *
 * A single read once the pill is visible says nothing about the frames before
 * it: the dock used to be painted over the page and given room only once its
 * measured height arrived, so a read could land in that gap (the CI flake) or
 * miss it (every other run), while the writer saw the timer over their words
 * either way. A frame callback measures what that frame will paint, so this
 * asserts on what a writer could see. Visible writing is the body inside the
 * sheet inside the page's scroller, since anything past the scroller is clipped.
 *
 * The sheet's entrance (`useEntrance`) fades it in while it slides up a few
 * pixels from below, so for its first frames the paper is drawn lower than
 * where it is laid out. That slide is a deliberate visual offset, not where the
 * page put the writing, so each frame is measured at the sheet's laid-out
 * position: the entrance's current translation is taken back out. Taking it
 * out leaves sub-pixel residue at the paper's edge, so an overlap counts once
 * it is deeper than the file's edge tolerance.
 */
async function watchPaintedOverlap(page: Page): Promise<void> {
  await page.evaluate(
    ({ key, tolerance }) => {
      const frames: OverlapFrame[] = [];
      const store = window as unknown as Record<string, OverlapFrame[] | (() => void)>;
      store[key] = frames;
      let watching = true;
      store[`${key}Stop`] = () => {
        watching = false;
      };
      const rectOf = (id: string): DOMRect | null =>
        document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect() ?? null;
      const sample = (): void => {
        if (!watching) return;
        const band = document.querySelector('[data-testid="writing-session-band"]');
        const sheetNode = document.querySelector('[data-testid="journal-sheet"]');
        const timer = rectOf('writing-timer-pill');
        const clips = ['journal-body-input', 'journal-sheet', 'journal-page-scroll'].map(rectOf);
        const painted = band !== null && Number(getComputedStyle(band).opacity) > 0;
        if (painted && sheetNode && timer && clips.every((rect) => rect !== null)) {
          const rects = clips as DOMRect[];
          const transform = getComputedStyle(sheetNode).transform;
          const slide = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
          const top = Math.max(...rects.map((r) => r.top)) - slide;
          const bottom = Math.min(...rects.map((r) => r.bottom)) - slide;
          const left = Math.max(...rects.map((r) => r.left));
          const right = Math.min(...rects.map((r) => r.right));
          const width = Math.min(right, timer.right) - Math.max(left, timer.left);
          const height = Math.min(bottom, timer.bottom) - Math.max(top, timer.top);
          if (width > 0 && height > tolerance)
            frames.push({
              area: Math.round(width * height),
              timer: [timer.top, timer.bottom].map(Math.round),
              writing: [top, bottom].map(Math.round),
            });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    },
    { key: OVERLAP_FRAMES, tolerance: EDGE_TOLERANCE },
  );
}

/** Stop the watch and return every painted frame in which the timer covered visible writing. */
async function paintedOverlaps(page: Page): Promise<OverlapFrame[]> {
  return page.evaluate((key) => {
    const store = window as unknown as Record<string, OverlapFrame[] | (() => void)>;
    (store[`${key}Stop`] as () => void)();
    return store[key] as OverlapFrame[];
  }, OVERLAP_FRAMES);
}

async function openWritingPage(page: Page, prefix: string, watch = false): Promise<void> {
  await signUp(page, prefix);
  if (watch) await watchPaintedOverlap(page);
  await page.getByTestId('journal-new-entry').click();
  await page
    .getByTestId('journal-body-input')
    .fill('The timer waits outside these words.\nA second line stays available to the writer.');
  await expect(page.getByTestId('writing-timer-pill')).toBeVisible();
}

async function expectHitTestClear(locator: Locator, message: string): Promise<void> {
  await expect
    .poll(
      () =>
        locator.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const points = [
            [box.left + box.width / 2, box.top + box.height / 2],
            [box.left + box.width / 2, box.top + 2],
            [box.left + box.width / 2, box.bottom - 2],
          ];
          return points.every(([x, y]) => {
            if (x === undefined || y === undefined) return false;
            const hit = document.elementFromPoint(x, y);
            return hit !== null && (hit === node || node.contains(hit));
          });
        }),
      { message },
    )
    .toBe(true);
}

async function expectCenterHit(locator: Locator, message: string): Promise<void> {
  await expect
    .poll(
      () =>
        locator.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return hit !== null && (hit === node || node.contains(hit));
        }),
      { message },
    )
    .toBe(true);
}

/** The timer, body and sheet boxes read in one task, so no re-render can fall between them. */
async function layoutSnapshot(page: Page): Promise<{ timer: Box; body: Box; sheet: Box }> {
  const boxes = await page.evaluate(() =>
    ['writing-timer-pill', 'journal-body-input', 'journal-sheet'].map((id) => {
      const rect = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    }),
  );
  const [timer, body, sheet] = boxes;
  if (!timer || !body || !sheet) throw new Error(`a box is missing: ${JSON.stringify(boxes)}`);
  return { timer, body, sheet };
}

async function expectIdleTimerClear(page: Page, phone: boolean): Promise<void> {
  const { timer, body, sheet } = await layoutSnapshot(page);
  const visibleBody = intersectionBox(body, sheet);
  expect(
    overlapArea(visibleBody, timer),
    'the untouched timer must not cover the visible writing body',
  ).toBe(0);

  if (phone) {
    expect(
      timer.y,
      'the untouched phone timer belongs below the paper, not over it',
    ).toBeGreaterThanOrEqual(sheet.y + sheet.height - EDGE_TOLERANCE);
    expect(timer.y, 'the idle timer starts inside the phone viewport').toBeGreaterThanOrEqual(0);
    expect(
      timer.y + timer.height,
      'the complete idle timer stays inside the phone viewport',
    ).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
  }

  const scroll = page.getByTestId('journal-page-scroll');
  const finish = page.getByTestId('journal-finish-button');
  for (const proportion of [0, 0.5, 1]) {
    await scroll.evaluate((node, ratio) => {
      node.scrollTop = (node.scrollHeight - node.clientHeight) * ratio;
    }, proportion);
    if (proportion === 1) {
      await expect(finish).toBeInViewport({ ratio: 1 });
      await expectHitTestClear(finish, 'Finish must receive taps across its full height');
    }
  }
  expect(
    await paintedOverlaps(page),
    'no painted frame may show the untouched timer over the writing',
  ).toEqual([]);
}

async function runViewport(
  browser: Browser,
  viewport: typeof PHONE | typeof LAPTOP,
  zoom: number,
  prefix: string,
  screenshotPath: string,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: viewport.width / zoom, height: viewport.height / zoom },
    deviceScaleFactor: zoom,
  });
  const page = await context.newPage();
  try {
    await openWritingPage(page, prefix, true);
    await page.screenshot({ path: screenshotPath });
    await expectIdleTimerClear(page, viewport.width === PHONE.width);

    await page.getByTestId('writing-timer-start').click();
    await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
    await expect(page.getByTestId('writing-session-band')).toHaveCSS('position', 'absolute');
    await expectHitTestClear(
      page.getByTestId('writing-timer-stop'),
      'the existing running timer must remain operable',
    );
  } finally {
    await context.close();
  }
}

for (const [label, viewport, zoom] of [
  ['390x844-100', PHONE, 1],
  ['390x844-200', PHONE, ZOOM_200],
  ['1280x800-100', LAPTOP, 1],
] as const) {
  test(`the untouched timer stays off the writing at ${label}`, async ({ browser }, testInfo) => {
    await runViewport(
      browser,
      viewport,
      zoom,
      `idle-timer-${label}`,
      testInfo.outputPath(`idle-timer-${label}.png`),
    );
  });
}

test('an extreme-zoom split-screen dock scrolls every timer control into reach', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: SHORT_PHONE.width / ZOOM_200, height: SHORT_PHONE.height / ZOOM_200 },
    deviceScaleFactor: ZOOM_200,
  });
  const page = await context.newPage();
  try {
    await openWritingPage(page, 'idle-dock-short-zoom');
    const band = page.getByTestId('writing-session-band');
    const content = page.getByTestId('writing-session-band-content');
    const headerTitle = page.locator('h1:visible', { hasText: /^Journal$/ }).first();
    const pageScroll = page.getByTestId('journal-page-scroll');
    await pageScroll.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    const bandBox = await boxOf(band, 'constrained idle dock');
    const contentBox = await boxOf(content, 'constrained idle dock scroll viewport');
    const dockCss = await band.evaluate((node) => ({
      innerHeight: window.innerHeight,
      maxHeight: getComputedStyle(node).maxHeight,
      overflow: getComputedStyle(node).overflow,
    }));
    expect(bandBox.y, JSON.stringify(dockCss)).toBeGreaterThanOrEqual(0);
    expect(dockCss.overflow).toBe('hidden');
    expect(bandBox.y + bandBox.height).toBeLessThanOrEqual(SHORT_PHONE.height / ZOOM_200);
    expect(contentBox.y).toBeGreaterThanOrEqual(bandBox.y);
    expect(contentBox.y + contentBox.height).toBeLessThanOrEqual(
      bandBox.y + bandBox.height + EDGE_TOLERANCE,
    );
    const overflow = await content.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);

    const outerBefore = await page.evaluate(() => window.scrollY);
    const pageScrollBefore = await pageScroll.evaluate((node) => node.scrollTop);
    await expect(headerTitle).toBeInViewport();
    await expectCenterHit(
      headerTitle,
      'the stationary Journal header starts unobstructed above the dock',
    );
    await expect(page.getByTestId('writing-timer-start')).toBeInViewport();
    await expectHitTestClear(page.getByTestId('writing-timer-start'), 'Start remains reachable');
    await page.screenshot({
      path: testInfo.outputPath('idle-dock-short-390x300-200-top.png'),
    });
    await content.hover();
    await page.mouse.wheel(0, overflow.scrollHeight);
    await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByTestId('writing-timer-preset-45')).toBeInViewport();
    await expectHitTestClear(
      page.getByTestId('writing-timer-preset-45'),
      'the final preset remains reachable after dock scroll',
    );
    expect(await page.evaluate(() => window.scrollY)).toBe(outerBefore);
    expect(await pageScroll.evaluate((node) => node.scrollTop)).toBe(pageScrollBefore);
    const scrolledBandBox = await boxOf(band, 'scrolled constrained idle dock');
    expect(scrolledBandBox.y).toBeGreaterThanOrEqual(0);
    expect(scrolledBandBox.y + scrolledBandBox.height).toBeLessThanOrEqual(
      SHORT_PHONE.height / ZOOM_200,
    );
    const scrolledContentBox = await boxOf(content, 'scrolled idle dock viewport');
    expect(scrolledContentBox.y).toBeGreaterThanOrEqual(scrolledBandBox.y);
    expect(scrolledContentBox.y + scrolledContentBox.height).toBeLessThanOrEqual(
      scrolledBandBox.y + scrolledBandBox.height + EDGE_TOLERANCE,
    );
    await expect(headerTitle).toBeInViewport();
    await expectCenterHit(
      headerTitle,
      'the stationary Journal header stays unobstructed above the dock',
    );
    await page.screenshot({
      path: testInfo.outputPath('idle-dock-short-390x300-200-bottom.png'),
    });

    await content.hover();
    await page.mouse.wheel(0, -overflow.scrollHeight);
    await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
    await page.getByTestId('writing-timer-start').click();
    await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
    await expect(page.getByTestId('writing-session-band')).toHaveCSS('position', 'absolute');
    const runningScrollBefore = await content.evaluate((node) => node.scrollTop);
    await content.hover();
    await page.mouse.wheel(0, overflow.scrollHeight);
    await expect
      .poll(() => content.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(runningScrollBefore);
    const stop = page.getByTestId('writing-timer-stop');
    await expect(stop).toBeInViewport();
    await expectCenterHit(stop, 'Stop remains reachable after starting at extreme zoom');
  } finally {
    await context.close();
  }
});
