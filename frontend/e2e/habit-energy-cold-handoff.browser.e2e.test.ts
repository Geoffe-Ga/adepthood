import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

import {
  frontendUrl,
  openHabits,
  seedHabit,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * #3328: Course's "Start Energy Scaffolding" opened the Habits onboarding on
 * the cold tab's first render, before the account's habits had arrived. The
 * modal seeds its review once, on entry, so a returning user was asked about
 * nothing: the new-user flow, whose save would scaffold beside rows it never
 * showed. The handoff now waits for the server's list under the live session,
 * says so while it waits, and keeps a failed read retryable.
 */
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
];
const SEEDED = ['Morning sitting by the window', 'Evening walk along the river'];
const WAITING = 'Energy Scaffolding will open once your habits have loaded.';
const HABITS_LIST = /\/habits\/\?/u;

/** Exercise rendered text enlargement only; this is not an OS text-scaling claim. */
async function doubleText(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    for (const child of [element, ...element.querySelectorAll<HTMLElement>('*')]) {
      if (
        !(child instanceof HTMLElement) ||
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

/** Every text-bearing node inside `target` is unclipped and inside the viewport and `target`. */
async function expectContainedGlyphs(target: Locator): Promise<void> {
  const escaped = await target.evaluate((element) => {
    const outer = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>('*')]
      .filter((node) => {
        if (
          ![...node.childNodes].some(
            (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
          )
        )
          return false;
        const rect = node.getBoundingClientRect();
        return (
          node.scrollWidth > node.clientWidth + 1 ||
          rect.left < Math.max(outer.left, 0) - 1 ||
          rect.right > Math.min(outer.right, innerWidth) + 1 ||
          rect.bottom > outer.bottom + 1
        );
      })
      .map((node) => node.textContent);
  });
  expect(escaped).toEqual([]);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Hold the first habits-list GET until `release` is called. */
async function holdFirstHabitsRead(page: Page) {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  let reached = false;
  await page.route(HABITS_LIST, async (route: Route) => {
    if (route.request().method() !== 'GET' || held) {
      await route.continue();
    } else {
      held = true;
      const response = await route.fetch();
      reached = true;
      await hold;
      await route.fulfill({ response });
    }
  });
  return { release, reached: () => reached };
}

async function startFromCourse(page: Page): Promise<void> {
  await page.goto(`${frontendUrl()}/course`);
  await expect(page.getByTestId('start-here-section')).toBeVisible();
  const energy = page.getByRole('button', { name: 'Start Energy Scaffolding', exact: true });
  await energy.scrollIntoViewIfNeeded();
  await energy.click();
}

for (const viewport of VIEWPORTS) {
  test(`a cold Energy handoff waits for a returning user's habits at ${viewport.width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize(viewport);
    const email = await signUp(page, 'energy-cold-handoff');
    const token = await tokenFor(request, email);
    for (const name of SEEDED) await seedHabit(request, token, name);
    const read = await holdFirstHabitsRead(page);
    const modal = page.getByTestId('onboarding-modal-content');
    try {
      await startFromCourse(page);
      await expect.poll(read.reached).toBe(true);
      const notice = page.getByTestId('energy-handoff-notice');
      // Whichever the Habits tab renders first: before #3328 it was the modal,
      // seeded with no rows while the account's list was still on the wire.
      await expect(notice.or(modal)).toBeVisible();
      await expect(modal, 'the review opened before the habits arrived').toBeHidden();
      await expect(notice.getByText(WAITING, { exact: true })).toBeVisible();
      await expectContainedGlyphs(notice);
      await expectNoSidewaysScroll(page);
      await page.screenshot({ path: info.outputPath(`waiting-${viewport.width}-1x.png`) });
      await doubleText(notice);
      await expectContainedGlyphs(notice);
      await expectNoSidewaysScroll(page);
      await page.screenshot({ path: info.outputPath(`waiting-${viewport.width}-2x.png`) });
      await expect(modal).toBeHidden();
    } finally {
      read.release();
    }
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('review-step')).toBeVisible();
    for (const name of SEEDED) {
      await expect(
        page.locator('[data-testid^="review-row-"]').filter({ hasText: name }),
      ).toBeVisible();
    }
    await expect(page.getByTestId('energy-handoff-notice')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`review-${viewport.width}-1x.png`) });
    await doubleText(page.getByTestId('review-step'));
    await page.screenshot({ path: info.outputPath(`review-${viewport.width}-2x.png`) });
  });
}

test('a failed cold read keeps the Energy handoff and opens it once the retry succeeds', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize(VIEWPORTS[0]!);
  const email = await signUp(page, 'energy-cold-retry');
  const token = await tokenFor(request, email);
  await seedHabit(request, token, SEEDED[0]!);
  let failing = true;
  await page.route(HABITS_LIST, async (route: Route) => {
    if (route.request().method() === 'GET' && failing) {
      await route.fulfill({ status: 503, json: { detail: 'controlled_habits_unavailable' } });
    } else {
      await route.continue();
    }
  });
  await startFromCourse(page);
  const notice = page.getByTestId('energy-handoff-notice');
  await expect(
    notice.getByText(
      "We couldn't load your habits, so Energy Scaffolding hasn't opened yet. It will open once they load.",
      { exact: true },
    ),
  ).toBeVisible();
  // The error banner already offers the retry; the notice does not repeat it.
  await expect(page.getByTestId('habits-error-banner')).toBeVisible();
  await expect(page.getByTestId('energy-handoff-retry')).toHaveCount(0);
  await expect(page.getByTestId('onboarding-modal-content')).toBeHidden();
  await expectContainedGlyphs(notice);
  await page.screenshot({ path: info.outputPath('failed-390-1x.png') });
  failing = false;
  await page.getByTestId('retry-button').click();
  await expect(page.getByTestId('onboarding-modal-content')).toBeVisible();
  await expect(
    page.locator('[data-testid^="review-row-"]').filter({ hasText: SEEDED[0]! }),
  ).toBeVisible();
});

for (const viewport of VIEWPORTS) {
  test(`a failed read behind cached rows offers the handoff's own retry at ${viewport.width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize(viewport);
    const email = await signUp(page, 'energy-cached-retry');
    const token = await tokenFor(request, email);
    await seedHabit(request, token, SEEDED[0]!);
    // One healthy visit leaves this account's rows in the device cache.
    await openHabits(page);
    await expect(page.getByText(SEEDED[0]!, { exact: true })).toBeVisible();
    let failing = true;
    await page.route(HABITS_LIST, async (route: Route) => {
      if (route.request().method() === 'GET' && failing) {
        await route.fulfill({ status: 503, json: { detail: 'controlled_habits_unavailable' } });
      } else {
        await route.continue();
      }
    });
    await startFromCourse(page);
    const notice = page.getByTestId('energy-handoff-notice');
    const retry = page.getByTestId('energy-handoff-retry');
    await expect(retry).toBeVisible();
    // The cached rows stay on screen, so there is no error banner to carry the retry.
    await expect(page.getByTestId('habits-error-banner')).toHaveCount(0);
    await expect(page.getByTestId('onboarding-modal-content')).toBeHidden();
    await expectContainedGlyphs(notice);
    await expectNoSidewaysScroll(page);
    await page.screenshot({ path: info.outputPath(`cached-failed-${viewport.width}-1x.png`) });
    await doubleText(notice);
    await expectContainedGlyphs(notice);
    await expectNoSidewaysScroll(page);
    await page.screenshot({ path: info.outputPath(`cached-failed-${viewport.width}-2x.png`) });
    failing = false;
    await retry.click();
    await expect(page.getByTestId('onboarding-modal-content')).toBeVisible();
    await expect(
      page.locator('[data-testid^="review-row-"]').filter({ hasText: SEEDED[0]! }),
    ).toBeVisible();
  });
}

test('declining a held Energy handoff leaves the Habits tab without opening it', async ({
  page,
  request,
}) => {
  await page.setViewportSize(VIEWPORTS[0]!);
  const email = await signUp(page, 'energy-cold-decline');
  const token = await tokenFor(request, email);
  await seedHabit(request, token, SEEDED[0]!);
  const read = await holdFirstHabitsRead(page);
  try {
    await startFromCourse(page);
    await expect.poll(read.reached).toBe(true);
    await page.getByTestId('energy-handoff-cancel').click();
    await expect(page.getByTestId('energy-handoff-notice')).toHaveCount(0);
  } finally {
    read.release();
  }
  await expect(page.getByText(SEEDED[0]!, { exact: true })).toBeVisible();
  await expect(page.getByTestId('onboarding-modal-content')).toBeHidden();
});
