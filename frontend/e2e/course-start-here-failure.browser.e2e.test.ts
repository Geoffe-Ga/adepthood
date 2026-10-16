import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl, sessionFor, signUp } from './journalHabitsBrowserSupport';

// #3344: on bare Course entry the stage list loads while a Start Here read
// fails. The Course keeps its stage pills and drawer, Start Here says the read
// failed and offers a retry, and the retry restores the confirmed resources,
// progress, read marks and the resource-first Read next.

interface Resource {
  slug: string;
  title: string;
  order: number;
  is_read: boolean;
}
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
];
// Each width fails each Start Here read once across the two text scales.
const FAILING_READ: Record<number, string> = {
  1: '/course/site-resources',
  2: '/course/start-here/progress',
};
const START_HERE_ERROR = "Start Here couldn't load, so your progress isn't shown.";
const MIN_TOUCH_TARGET = 44;
// Enough presses to walk from the Start Here pill past every stage pill.
const MAX_TAB_STOPS = 20;

/** Exercise rendered text enlargement only; this is not an OS text-scaling claim. */
async function doubleText(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    for (const child of element.querySelectorAll<HTMLElement>('*')) {
      if (
        ![...child.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        )
      )
        continue;
      const computed = getComputedStyle(child);
      child.style.fontSize = `${Number.parseFloat(computed.fontSize) * 2}px`;
      if (computed.lineHeight !== 'normal')
        child.style.lineHeight = `${Number.parseFloat(computed.lineHeight) * 2}px`;
    }
  });
}

async function expectVisibleGlyphs(target: Locator): Promise<void> {
  const clipped = await target.evaluate((element) =>
    [...element.querySelectorAll<HTMLElement>('*')]
      .filter((node) => {
        if (
          ![...node.childNodes].some(
            (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
          )
        )
          return false;
        const rect = node.getBoundingClientRect();
        return (
          node.scrollWidth > node.clientWidth + 1 || rect.left < -1 || rect.right > innerWidth + 1
        );
      })
      .map((node) => node.textContent),
  );
  expect(clipped).toEqual([]);
}

/** Reach `target` with Tab from the Start Here pill, so the browser paints its keyboard focus ring. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  await page.getByTestId('start-here-pill').focus();
  for (let stop = 0; stop < MAX_TAB_STOPS; stop += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** A fresh account whose first Start Here resource is already confirmed read. */
async function accountWithOneMark(page: Page): Promise<{ total: number; first: Resource }> {
  const email = await signUp(page, 'course-start-here-failure');
  const { token } = await sessionFor(page.request, email);
  const listed = await page.request.get(`${backendUrl()}/course/site-resources`, {
    headers: bearer(token),
  });
  const resources = ((await listed.json()) as Resource[]).sort((a, b) => a.order - b.order);
  const first = resources[0]!;
  const marked = await page.request.post(
    `${backendUrl()}/course/site-resources/${encodeURIComponent(first.slug)}/mark-read`,
    { headers: bearer(token) },
  );
  expect(marked.ok()).toBe(true);
  return { total: resources.length, first };
}

/** A healthy chapter still opens from the stage pills, and the drawer still lists the stages. */
async function expectChapterNavigation(page: Page): Promise<void> {
  await page.getByTestId('stage-pill-1').click();
  await expect(page.getByTestId('stage-cover')).toBeVisible();
  await page.locator('[data-testid^="content-card-"]').first().click();
  await expect(page.getByTestId('chapter-reader')).toBeVisible();
  await page.getByTestId('reader-back-button').click();
  await page.getByRole('button', { name: 'Open Course menu' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByTestId('course-drawer-stage-1')).toBeVisible();
  await expect(
    drawer.getByRole('button', { name: "Start Here couldn't load. Tap to retry.", exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
}

for (const viewport of VIEWPORTS) {
  for (const textScale of [1, 2]) {
    const failing = FAILING_READ[textScale]!;
    test(`bare Course keeps chapter navigation when ${failing} fails at ${viewport.width}px and ${textScale}x text`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const { total, first } = await accountWithOneMark(page);
      const failedRead = (url: URL) => url.pathname === failing;
      // Controlled transport failure only; no successful payload is replaced.
      await page.route(failedRead, (route) =>
        route.fulfill({ status: 503, json: { detail: 'controlled_start_here_unavailable' } }),
      );
      await page.goto(`${frontendUrl()}/course`);

      const section = page.getByTestId('start-here-section');
      await expect(section.getByText(START_HERE_ERROR, { exact: true })).toBeVisible();
      await expect(page.getByTestId('course-error')).toHaveCount(0);
      // Unknown progress opens Start Here, never the chapter it could reach only
      // by assuming every resource is read.
      await expect(page.getByTestId('stage-cover')).toHaveCount(0);
      await expect(section.getByText(/ of \d+ read$/)).toHaveCount(0);

      await expectChapterNavigation(page);
      await page.getByTestId('start-here-pill').click();
      const retry = section.getByRole('button', { name: 'Try again', exact: true });
      await expect(retry).toBeVisible();
      const box = await retry.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      const pill = page.getByTestId('start-here-pill');
      if (textScale === 2) {
        await doubleText(pill);
        await doubleText(section);
      }
      await expectVisibleGlyphs(pill);
      await expectVisibleGlyphs(section);
      await page.screenshot({
        path: testInfo.outputPath(`start-here-failed-${viewport.width}-${textScale}x.png`),
      });

      // Keyboard retry once the read can succeed.
      await page.unroute(failedRead);
      await tabTo(page, retry);
      await expect(retry).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath(`start-here-retry-focus-${viewport.width}-${textScale}x.png`),
      });
      const reasked = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/course/next-unread',
      );
      await page.keyboard.press('Enter');
      await expect(section.getByText(`1 of ${total} read`, { exact: true })).toBeVisible();
      await expect(section.getByText(START_HERE_ERROR, { exact: true })).toHaveCount(0);
      expect((await reasked).status()).toBe(200);
      const cards = section.locator('[data-testid^="start-here-resource-"]');
      await expect(cards).toHaveCount(total);
      await expect(cards.first()).toHaveAttribute('aria-label', `Open ${first.title}, read`);
      // Read next stays resource-first, past the confirmed resource.
      await expect(page.getByTestId('read-next')).toHaveAttribute('aria-label', /^Read next: /);
      await expect(page.getByTestId('read-next')).not.toHaveAttribute(
        'aria-label',
        `Read next: ${first.title}`,
      );
      // The retry answers Start Here; it does not move the reader's selection.
      await expect(page.getByTestId('stage-cover')).toHaveCount(0);
      if (textScale === 2) await doubleText(section);
      await expectVisibleGlyphs(section);
      await page.screenshot({
        path: testInfo.outputPath(`start-here-restored-${viewport.width}-${textScale}x.png`),
      });
    });
  }
}
