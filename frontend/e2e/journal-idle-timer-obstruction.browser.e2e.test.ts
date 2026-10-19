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

async function openWritingPage(page: Page, prefix: string): Promise<void> {
  await signUp(page, prefix);
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

async function expectIdleTimerClear(page: Page, phone: boolean): Promise<void> {
  const timer = await boxOf(page.getByTestId('writing-timer-pill'), 'idle timer');
  const body = await boxOf(page.getByTestId('journal-body-input'), 'writing body');
  const sheet = await boxOf(page.getByTestId('journal-sheet'), 'journal sheet');
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
    await openWritingPage(page, prefix);
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
