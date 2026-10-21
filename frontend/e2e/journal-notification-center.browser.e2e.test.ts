import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type TestInfo,
} from '@playwright/test';

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

/**
 * The reads the door's count sums (`useNotificationCount`): the Return check,
 * the invitations, the stage's prompts, voice readiness and the due review.
 * Each loads on its own, and the label shows as soon as any one has answered
 * (#3481). The morning-pages tip is read from device storage, not the network.
 */
const COUNT_SOURCES = [
  /^\/metta-return$/u,
  /^\/invitations$/u,
  /^\/prompts\/stage\/\d+$/u,
  /^\/corpus\/voice-readiness$/u,
  /^\/reflections\/due$/u,
];
/** How long a settled reading must hold still before it is trusted. */
const STEADY_MS = 500;

interface CountSources {
  /** Every source has answered at least once, and none is still out. */
  settled: () => boolean;
}

/** Follow the count's source reads from before the app first asks for them. */
function trackCountSources(page: Page): CountSources {
  const inFlight = new Set<Request>();
  const answered = new Set<number>();
  const source = (request: Request): number =>
    request.method() === 'GET'
      ? COUNT_SOURCES.findIndex((pattern) => pattern.test(new URL(request.url()).pathname))
      : -1;
  page.on('request', (request) => {
    if (source(request) >= 0) inFlight.add(request);
  });
  const finished = (request: Request): void => {
    const index = source(request);
    if (index < 0) return;
    inFlight.delete(request);
    answered.add(index);
  };
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  return { settled: () => inFlight.size === 0 && answered.size === COUNT_SOURCES.length };
}

/**
 * Read `read` once the count's sources have all answered and the reading has
 * held still for {@link STEADY_MS}: an answer arrives a moment before it is
 * rendered, so a single read can still catch the page between the two.
 */
async function settledReading<T>(
  sources: CountSources,
  read: () => Promise<T>,
  what: string,
): Promise<T> {
  await expect
    .poll(sources.settled, { message: `every source of the count has answered (${what})` })
    .toBe(true);
  let last: T | undefined;
  let held = false;
  await expect
    .poll(
      async () => {
        const now = await read();
        held = last !== undefined && now === last;
        last = now;
        return held && sources.settled();
      },
      { intervals: [STEADY_MS], message: `${what} has settled` },
    )
    .toBe(true);
  return last as T;
}

async function countOn(door: Locator): Promise<number> {
  const match = COUNTED_LABEL.exec((await door.textContent()) ?? '');
  return Number(match?.[1]);
}

/** The number of items the home's door says are waiting, once every source has loaded. */
async function waitingCount(page: Page, sources: CountSources): Promise<number> {
  const door = page.getByTestId(DOOR);
  await expect(door).toHaveText(COUNTED_LABEL);
  return settledReading(sources, () => countOn(door), 'the door count');
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

test('a writer opens the Notification Center, sets a prompt aside there, and the home count follows', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(PHONE);
  const sources = trackCountSources(page);
  await signUp(page, 'notification-center');

  // A fresh account is in Beige, whose three prompts are all still offered, so
  // the door counts at least those three; it is a number in words, no badge.
  const before = await waitingCount(page, sources);
  expect(before).toBeGreaterThanOrEqual(3);
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
  // Whether the voice band is offered is the server's answer, so wait for it
  // before deciding there is nothing to decline.
  const voiceDecline = reopened.getByTestId('journal-voice-readiness-dismiss');
  if ((await settledReading(sources, () => voiceDecline.count(), 'the voice band')) > 0)
    await voiceDecline.click();
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
      const sources = trackCountSources(page);
      await signUp(page, `notification-center-zoom-${label}`);
      const door = page.getByTestId(DOOR);
      // Measure the door at its settled label, not a narrower partial count.
      await waitingCount(page, sources);
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
