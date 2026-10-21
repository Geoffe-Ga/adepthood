import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

/**
 * The Notification Center (#3142): one quiet inbox for the prompts, reminders
 * and progress that sit above the fold on the Journal home.
 *
 * Crosses the seam a mocked suite cannot: the home's door reads its count from
 * the real stage-prompt, invitation, Return and voice-readiness routes; the
 * screen renders the stage's real prompts; a prompt set aside in the center goes
 * through the real dismiss route, and the home's count drops by exactly that one
 * card when the writer comes back. The drawer's count-free door opens the same
 * screen. Each layout is captured at a phone and a laptop width, at normal and
 * at 200% (the web's enlarged-text path) for review.
 */

const PHONE = { width: 390, height: 844 } as const;
const LAPTOP = { width: 1280, height: 720 } as const;
/** 200% browser zoom: half the CSS viewport at twice the device pixels. */
const ZOOM_200 = 2;
const DOOR = 'journal-notifications-open';
const CENTER = 'journal-notification-center';
const COUNTED_LABEL = /^Prompts \((\d+)\)$/u;

/** The number of items the home's door says are waiting, once it has loaded. */
async function waitingCount(page: Page): Promise<number> {
  const door = page.getByTestId(DOOR);
  await expect(door).toHaveText(COUNTED_LABEL);
  const match = COUNTED_LABEL.exec((await door.textContent()) ?? '');
  return Number(match?.[1]);
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

test('a writer opens the Notification Center, sets a prompt aside there, and the home count follows', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(PHONE);
  await signUp(page, 'notification-center');

  // A fresh account is in Beige, whose three prompts are all still offered, so
  // the door counts at least those three; it is a number in words, no badge.
  await page.waitForLoadState('networkidle');
  await expect.poll(() => waitingCount(page)).toBeGreaterThanOrEqual(3);
  const before = await waitingCount(page);
  await capture(page, testInfo, 'home-door-390');

  await page.getByTestId(DOOR).click();
  const center = page.getByTestId(CENTER);
  await expect(center).toBeVisible();
  await expect(center.getByRole('heading', { name: "This week's prompts" })).toBeVisible();
  const firstPrompt = center.getByTestId('journal-stage-prompt-card-1');
  await expect(firstPrompt).toBeVisible();
  // Counters sit first, under their own heading, and never hold off an item.
  await expect(center.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(center.getByTestId('journal-notification-center-empty')).toHaveCount(0);
  await capture(page, testInfo, 'center-390');

  // Declining is one tap, and it goes through the real route.
  const dismissed = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/prompts\/stage\/1\/1\/dismiss$/u.test(new URL(response.url()).pathname),
  );
  await center.getByTestId('journal-stage-prompt-set-aside-1').click();
  expect((await dismissed).ok()).toBe(true);
  await expect(center.getByTestId('journal-stage-prompt-card-1')).toHaveCount(0);
  await expect(center.getByTestId('journal-stage-prompts-set-aside-footer')).toHaveText(
    '1 set aside',
  );

  // Back on the home, the door has re-read its sources: one fewer card waits.
  await page.getByRole('button', { name: 'Open Prompts menu' }).click();
  await page.getByTestId('drawer-nav-Journal').click();
  await expect(page.getByTestId(DOOR)).toHaveText(`Prompts (${before - 1})`);

  // The drawer's door carries no count and opens the same screen.
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  const drawerDoor = page.getByRole('dialog').getByTestId('drawer-nav-Prompts');
  await expect(drawerDoor).toHaveText('Prompts');
  await drawerDoor.click();
  const reopened = page.getByTestId(CENTER);
  await expect(reopened).toBeVisible();
  await expect(reopened.getByTestId('journal-stage-prompt-card-2')).toBeVisible();

  await page.setViewportSize(LAPTOP);
  await capture(page, testInfo, 'center-1280');

  // Declining everything leaves only the counters, and the inbox says so once.
  for (const ordinal of [2, 3]) {
    await reopened.getByTestId(`journal-stage-prompt-set-aside-${ordinal}`).click();
    await expect(reopened.getByTestId(`journal-stage-prompt-card-${ordinal}`)).toHaveCount(0);
  }
  await reopened.getByTestId('journal-morning-pages-dismiss').click();
  const voiceDecline = reopened.getByTestId('journal-voice-readiness-dismiss');
  if ((await voiceDecline.count()) > 0) await voiceDecline.click();
  await expect(reopened.getByTestId('journal-notification-center-empty')).toHaveText(
    'Nothing waiting.',
  );
  await capture(page, testInfo, 'center-empty-1280');
  await page.setViewportSize(PHONE);
  await capture(page, testInfo, 'center-empty-390');
  await page.getByRole('button', { name: 'Open Prompts menu' }).click();
  await page.getByTestId('drawer-nav-Journal').click();
  await expect(page.getByTestId(DOOR)).toHaveText('Prompts');
});

test('the Notification Center and its door hold together at 200% text, phone and laptop', async ({
  browser,
}, testInfo) => {
  for (const [label, viewport] of [
    ['390', PHONE],
    ['1280', LAPTOP],
  ] as const) {
    const context = await browser.newContext({
      viewport: { width: viewport.width / ZOOM_200, height: viewport.height / ZOOM_200 },
      deviceScaleFactor: ZOOM_200,
    });
    const page = await context.newPage();
    try {
      await signUp(page, `notification-center-zoom-${label}`);
      const door = page.getByTestId(DOOR);
      await expect(door).toHaveText(COUNTED_LABEL);
      // The three doors may wrap at this size, but none may leave the screen.
      const box = await door.boundingBox();
      const width = viewport.width / ZOOM_200;
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1);
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      // Keyboard focus lands on the door with a visible ring; captured for review.
      await door.scrollIntoViewIfNeeded();
      // Reached by the keyboard (Shift+Tab back, Tab forward), so the browser
      // paints its focus-visible ring rather than treating it as a pointer focus.
      await door.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(door).toBeFocused();
      await capture(page, testInfo, `home-door-${label}-zoom200`);

      await door.click();
      const center = page.getByTestId(CENTER);
      await expect(center).toBeVisible();
      const card = center.getByTestId('journal-stage-prompt-card-1');
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await capture(page, testInfo, `center-${label}-zoom200`);
    } finally {
      await context.close();
    }
  }
});
