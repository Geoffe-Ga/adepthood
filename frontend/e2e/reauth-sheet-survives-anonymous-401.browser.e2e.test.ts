import { expect, test, type Page, type Route } from '@playwright/test';

import {
  ACCOUNT_PHRASE,
  openHabits,
  seedHabit,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';

/**
 * #3396: once a session expires the app holds no token, so every request a
 * still-mounted screen sends goes out anonymous. The first such request to be
 * refused (`GET /ui-flags` in practice) answers 401 `not_authenticated`. That
 * must not collapse the re-auth sheet to Get Started: the person signs back in
 * from the sheet and lands on the screen they were on.
 *
 * Only the expired credential is faked. Every request carrying it, the refresh
 * included, is answered 401 `session_expired` in the browser; anonymous
 * requests and the new session's requests reach the real backend, so the
 * `not_authenticated` 401 is the server's own.
 */

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;
const VIEWPORT_HEIGHT = 844;
const HTTP_UNAUTHORIZED = 401;
const UI_FLAGS_PATH = '/ui-flags';
const STORY_BUDGET_MS = 120_000;
const HABIT_NAME = 'Evening walk';
const TEXT_SCALE = 2;

interface ObservedRequest {
  path: string;
  anonymous: boolean;
  status: number;
}

/**
 * Expire whichever credential the app sends next: from then on every request
 * carrying it, `/auth/refresh` among them, is refused as a real expiry is.
 */
async function expireNextCredential(page: Page): Promise<void> {
  let expired: string | null = null;
  await page.route('**/*', async (route: Route) => {
    const authorization = route.request().headers().authorization;
    if (authorization !== undefined && route.request().resourceType() !== 'document') {
      expired ??= authorization;
    }
    if (authorization === undefined || authorization !== expired) {
      await route.fallback();
    } else {
      await route.fulfill({
        status: HTTP_UNAUTHORIZED,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'session_expired' }),
      });
    }
  });
}

/** Double every text leaf in the sheet, the targeted enlarged-text check. */
async function enlargeSheetText(page: Page): Promise<void> {
  await page.getByTestId('reauth-keyboard-avoiding').evaluate((root, scale) => {
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.childElementCount || !element.textContent?.trim()) continue;
      const style = getComputedStyle(element);
      element.style.fontSize = `${parseFloat(style.fontSize) * scale}px`;
      element.style.lineHeight = `${parseFloat(style.lineHeight) * scale}px`;
    }
  }, TEXT_SCALE);
}

/** The control is laid out whole inside the viewport, reachable without a sideways scroll. */
async function expectWithinViewport(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) throw new Error(`${testId} is not laid out`);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

function sheet(page: Page) {
  return page.getByTestId('reauth-email');
}

for (const width of [PHONE_WIDTH, DESKTOP_WIDTH]) {
  test(`the re-auth sheet survives an anonymous 401 and signs back in at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(STORY_BUDGET_MS);
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    const email = await signUp(page, 'reauth-sheet');
    const { token } = await sessionFor(page.request, email);
    await seedHabit(page.request, token, HABIT_NAME, undefined, true);

    const observed: ObservedRequest[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      observed.push({
        path: url.pathname,
        anonymous: response.request().headers().authorization === undefined,
        status: response.status(),
      });
    });

    await openHabits(page);
    await expireNextCredential(page);
    await page.reload();
    await expect(sheet(page)).toBeVisible();

    // The still-mounted app's anonymous read is refused by the real server...
    await expect
      .poll(() =>
        observed.some(
          (r) => r.path === UI_FLAGS_PATH && r.anonymous && r.status === HTTP_UNAUTHORIZED,
        ),
      )
      .toBe(true);
    // ...and the sheet is still the one asking, not Get Started.
    await expect(sheet(page)).toBeVisible();
    await expect(page.getByTestId('get-started-scroll')).toHaveCount(0);
    await expectWithinViewport(page, 'reauth-submit');
    await expectWithinViewport(page, 'reauth-dismiss');
    await page.screenshot({ path: testInfo.outputPath(`reauth-sheet-${width}.png`) });
    await enlargeSheetText(page);
    await expectWithinViewport(page, 'reauth-submit');
    await page.screenshot({ path: testInfo.outputPath(`reauth-sheet-200-${width}.png`) });

    await sheet(page).fill(email);
    await page.getByTestId('reauth-password').fill(ACCOUNT_PHRASE);
    await page.getByTestId('reauth-submit').click();

    // Back on the screen the expiry found them on, with their habits.
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByTestId('habits-list')).toBeVisible();
    await expect(page.getByText(HABIT_NAME).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`signed-back-in-${width}.png`) });
  });
}
