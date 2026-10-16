import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, bearer, sessionFor, signUp } from './journalHabitsBrowserSupport';

// #3343: Course stays mounted while the re-auth sheet signs a different
// account in. Both accounts here are fresh, so they share a null program
// anchor -- the case in which the stage loader never re-ran and the incoming
// account sat on an empty Start Here until the screen remounted.

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
// The browser lane's seeded passphrase (journalHabitsBrowserSupport).
const ACCOUNT_PHRASE = 'Journal-habits-browser-passphrase';
const SESSION_EXPIRED = {
  status: 401,
  contentType: 'application/json',
  body: '{"detail":"session_expired"}',
};

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

/** An incoming account whose first Start Here resource is already confirmed read. */
async function incomingAccountWithOneMark(page: Page): Promise<{ email: string; first: Resource }> {
  const context = await page.context().browser()!.newContext();
  const other = await context.newPage();
  const email = await signUp(other, 'course-switch-incoming');
  const { token } = await sessionFor(other.request, email);
  const listed = await other.request.get(`${backendUrl()}/course/site-resources`, {
    headers: bearer(token),
  });
  const first = ((await listed.json()) as Resource[]).sort((a, b) => a.order - b.order)[0]!;
  const marked = await other.request.post(
    `${backendUrl()}/course/site-resources/${encodeURIComponent(first.slug)}/mark-read`,
    { headers: bearer(token) },
  );
  expect(marked.ok()).toBe(true);
  await context.close();
  return { email, first };
}

async function openCourse(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Course', exact: true }).click();
}

/** Expire the outgoing session on its next Frequency read, then sign `email` in over it. */
async function signInOverMountedCourse(page: Page, email: string): Promise<void> {
  const expiredRefresh = (url: URL) => url.pathname === '/auth/refresh';
  const expiredRead = (url: URL) => url.pathname.startsWith('/course/stages/');
  await page.route(expiredRefresh, (route) => route.fulfill(SESSION_EXPIRED));
  await page.route(expiredRead, (route) => route.fulfill(SESSION_EXPIRED));
  await page.getByTestId('stage-pill-1').click();
  const sheet = page.getByTestId('reauth-sheet');
  await expect(sheet).toBeVisible();
  await page.unroute(expiredRefresh);
  await page.unroute(expiredRead);
  await sheet.getByTestId('reauth-email').fill(email);
  await sheet.getByTestId('reauth-password').fill(ACCOUNT_PHRASE);
  await sheet.getByTestId('reauth-submit').click();
  await expect(sheet).toHaveCount(0);
}

for (const viewport of VIEWPORTS) {
  for (const textScale of [1, 2]) {
    test(`Start Here reloads for the incoming account without a remount at ${viewport.width}px and ${textScale}x text`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const incoming = await incomingAccountWithOneMark(page);
      await signUp(page, 'course-switch-outgoing');
      await openCourse(page);
      const section = page.getByTestId('start-here-section');
      await expect(section).toBeVisible();
      await expect(section.getByText(/^0 of \d+ read$/)).toBeVisible();
      const total = Number(
        /of (\d+) read/.exec((await section.getByText(/^0 of \d+ read$/).textContent())!)![1],
      );
      // Survives only while the running app (and so the mounted Course) does.
      await page.evaluate(() => {
        document.documentElement.dataset.courseWitness = 'same-running-app';
      });

      const incomingReads: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path === '/course/site-resources' || path === '/course/start-here/progress')
          incomingReads.push(path);
      });
      await signInOverMountedCourse(page, incoming.email);
      await expect(page.locator('html')).toHaveAttribute('data-course-witness', 'same-running-app');

      // The incoming account's Start Here holds its own resources and
      // confirmed read mark, without a reload or tab remount. (The landing
      // re-derives for the new account; the pill is pressed so the outgoing
      // account's Frequency tap cannot hide an empty Start Here.)
      await page.getByTestId('start-here-pill').click();
      await expect(section).toBeVisible();
      await expect(section.getByText(`1 of ${total} read`, { exact: true })).toBeVisible();
      const card = page.getByTestId(`start-here-resource-${incoming.first.slug}`);
      await expect(card).toHaveAttribute('aria-label', `Open ${incoming.first.title}, read`);
      expect(incomingReads).toEqual(
        expect.arrayContaining(['/course/site-resources', '/course/start-here/progress']),
      );
      // Read next stays resource-first for the incoming account.
      await expect(page.getByTestId('read-next')).toHaveAttribute('aria-label', /^Read next: /);
      await expect(page.getByTestId('read-next')).not.toHaveAttribute(
        'aria-label',
        `Read next: ${incoming.first.title}`,
      );

      const pill = page.getByTestId('start-here-pill');
      if (textScale === 2) {
        await doubleText(pill);
        await doubleText(section);
      }
      await expectVisibleGlyphs(pill);
      await expectVisibleGlyphs(section);
      await page.screenshot({
        path: testInfo.outputPath(`start-here-after-switch-${viewport.width}-${textScale}x.png`),
      });

      // Keyboard: the incoming account's confirmed card opens from Enter.
      await card.focus();
      await expect(card).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath(`start-here-switch-focus-${viewport.width}-${textScale}x.png`),
      });
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('reader-markdown')).toBeVisible();
      // The footer is offered once the page's end is in view.
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.wheel(0, 100_000);
      await expect(page.getByTestId('resource-mark-read-button')).toHaveAttribute(
        'aria-label',
        'Already read',
      );
      await expect(page.locator('html')).toHaveAttribute('data-course-witness', 'same-running-app');
    });
  }
}
