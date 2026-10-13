import { expect, test, type Locator, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

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

function clippedTo(box: Box, clip: Box): Box {
  const x = Math.max(box.x, clip.x);
  const y = Math.max(box.y, clip.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(box.x + box.width, clip.x + clip.width) - x),
    height: Math.max(0, Math.min(box.y + box.height, clip.y + clip.height) - y),
  };
}

async function openWritingPage(page: Page): Promise<void> {
  await signUp(page, 'writing-timer-layout');
  await page.getByTestId('journal-new-entry').click();
  await page
    .getByTestId('journal-body-input')
    .fill('A line held open while the writing timer waits below the page.');
}

test('the idle timer does not cover the entry body at 1280x720', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openWritingPage(page);

  const scroll = page.getByTestId('journal-page-scroll');
  await scroll.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(scroll).toHaveJSProperty('scrollTop', 0);

  const body = await boxOf(page.getByTestId('journal-body-input'), 'journal body');
  const scrollViewport = await boxOf(scroll, 'journal scroll viewport');
  const idleTimer = await boxOf(page.getByTestId('writing-timer-pill'), 'idle timer');
  const visibleBody = clippedTo(body, scrollViewport);

  expect(visibleBody.width, 'the journal body has no visible width').toBeGreaterThan(0);
  expect(visibleBody.height, 'the journal body has no visible height').toBeGreaterThan(0);
  expect(
    overlapArea(visibleBody, idleTimer),
    `the idle timer covers the visible writing field: body=${JSON.stringify(visibleBody)} timer=${JSON.stringify(idleTimer)}`,
  ).toBe(0);

  await page.getByTestId('writing-timer-start').click();
  await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
  const runningPill = await boxOf(page.getByTestId('writing-timer-pill'), 'running timer pill');
  expect(runningPill.width, 'the running timer left its 44dp desktop rail').toBeLessThanOrEqual(44);
  expect(overlapArea(visibleBody, runningPill), 'the running timer covers the writing field').toBe(
    0,
  );
});

/** Scroll the page to its true end, then hit-test both edges after layout settles. */
async function expectReachable(page: Page, testId: string): Promise<void> {
  const control = page.getByTestId(testId);
  await expect(control).toBeEnabled();
  if (testId === 'get-resonance-button') {
    await expect(control.locator('..')).toHaveCSS('opacity', '1');
  }
  await expect
    .poll(
      async () => {
        await page.getByTestId('journal-page-scroll').evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        return control.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const x = box.left + box.width / 2;
          return [box.top + 2, box.bottom - 2].map((y) => {
            const hit = document.elementFromPoint(x, y);
            return {
              clear: hit !== null && (hit === node || node.contains(hit)),
              covering: hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? hit?.tagName,
              x,
              y,
            };
          });
        });
      },
      { message: `${testId} must clear the floating band by its entire box` },
    )
    .toEqual([expect.objectContaining({ clear: true }), expect.objectContaining({ clear: true })]);
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`Finish and Resonance stay reachable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await openWritingPage(page);
    await page.clock.install();
    const sheet = page.getByTestId('journal-sheet');
    const idleSheet = await boxOf(sheet, 'idle sheet');
    await page.clock.fastForward(4_000);
    await expectReachable(page, 'journal-finish-button');
    await expectReachable(page, 'get-resonance-button');
    await page.screenshot({ path: testInfo.outputPath('idle-timer.png') });
    await page.getByTestId('writing-timer-start').click();
    await page.clock.fastForward(4_000);
    await expectReachable(page, 'journal-finish-button');
    await expectReachable(page, 'get-resonance-button');
    expect((await boxOf(sheet, 'running sheet')).height).toBe(idleSheet.height);
    await page.screenshot({ path: testInfo.outputPath('running-timer.png') });

    await page.clock.fastForward(20 * 60_000);
    await expect(page.getByTestId('writing-session-banner')).toBeVisible();
    await expectReachable(page, 'journal-finish-button');
    await expectReachable(page, 'get-resonance-button');
    expect((await boxOf(sheet, 'finished sheet')).height).toBe(idleSheet.height);
    const note = await boxOf(page.getByTestId('writing-session-banner'), 'finished note');
    expect(note.width).toBeLessThanOrEqual(680);
    await page.screenshot({ path: testInfo.outputPath('finished-note.png') });

    await page.getByTestId('journal-finish-button').click();
    await expect(page.getByTestId('journal-edit-button')).toBeVisible();
  });
}
