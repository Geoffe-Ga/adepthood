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
});
