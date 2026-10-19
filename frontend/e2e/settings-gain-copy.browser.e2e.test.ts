import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { frontendUrl, signUp } from './journalHabitsBrowserSupport';

/**
 * #3106 — the Settings gains stay readable at the three review dimensions.
 *
 * The shared lane pins a configured Sangha URL in ``frontendEnv``, so clean CI
 * sees all four depth rows and the real external-door copy. The
 * journey uses the production settings route, depth-preference read and vault
 * connection reads; only screenshots are written out of band.
 */

const PHASE = process.env.SETTINGS_GAIN_ARTIFACT_PHASE === 'before' ? 'before' : 'after';
const ARTIFACTS = join(__dirname, 'artifacts', 'settings-gain-copy-3106', PHASE);
const DEPTHS = ['habits', 'practices', 'course', 'sangha'] as const;
const GAINS = {
  habits: 'Build one habit from one minute a day across three weeks.',
  practices: 'Grow a practice from one minute to 45 minutes across the arc.',
  course: 'Explore ten capacities through readings paced by the calendar.',
  sangha: 'Find company that helps you feel less alone in the room you are actually in.',
} as const;
const SANGHA_LEAD =
  'There are people walking this with you, and the point of meeting them is to feel less ' +
  'alone in the room you are actually in. Adepthood works without it, and the door is ' +
  'one tap either way.';
const HIGHER_SELF_GAIN =
  'With sorting on, a reflection from your Higher Self can reach beyond your last few ' +
  'entries into what you have already written. When it draws from sorted writing, it uses ' +
  'a few passages at a time and can lean toward where you stand in the course, never using ' +
  'an Intimate one. Everything else you write here is sorted by Aspect.';

async function expectNoHorizontalClipping(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const geometry = await locator.evaluate((node) => {
    const clipped = Array.from(node.querySelectorAll<HTMLElement>('*')).flatMap((child) => {
      if (child.childElementCount > 0 || !child.textContent?.trim()) return [];
      const range = document.createRange();
      range.selectNodeContents(child);
      return Array.from(range.getClientRects())
        .filter((line) => line.left < -1 || line.right > window.innerWidth + 1)
        .map(() => child.textContent?.trim() ?? '');
    });
    return {
      clipped,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(geometry.clipped).toEqual([]);
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
}

async function captureViewport(page: Page, label: string, surface: string): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({
    path: join(ARTIFACTS, `${label}-${surface}.png`),
    animations: 'disabled',
  });
}

async function captureFullPage(page: Page, label: string, surface: string): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({
    path: join(ARTIFACTS, `${label}-${surface}-full.png`),
    animations: 'disabled',
    fullPage: true,
  });
}

async function exercise(
  browser: Browser,
  label: string,
  viewport: { width: number; height: number },
  deviceScaleFactor = 1,
): Promise<void> {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await context.newPage();
  try {
    await signUp(page, `settings-gain-${label}`);
    const depthRead = page.waitForResponse(
      (response) =>
        response.url().endsWith('/depth-preferences') && response.request().method() === 'GET',
    );
    await page.goto(`${frontendUrl()}/settings`);
    await depthRead;
    const depths = page.getByTestId('settings-group-depths');
    await depths.scrollIntoViewIfNeeded();
    await expectNoHorizontalClipping(depths);
    for (const depth of DEPTHS) {
      const row = page.getByTestId(`depth-row-${depth}`);
      await expectNoHorizontalClipping(row);
      await expect(row.getByRole('switch')).toHaveCount(1);
      await expect(row.getByText(GAINS[depth], { exact: true })).toBeVisible();
      if (deviceScaleFactor === 2) await captureViewport(page, label, `depth-${depth}`);
    }
    await page.getByText('Choose your depths', { exact: true }).scrollIntoViewIfNeeded();
    await captureViewport(page, label, 'depths');
    if (deviceScaleFactor === 2) await captureFullPage(page, label, 'depths');

    const sangha = page.getByTestId('settings-group-sangha');
    await expectNoHorizontalClipping(sangha);
    await expect(sangha.getByText(SANGHA_LEAD, { exact: true })).toBeVisible();
    const decline = sangha.getByText(/Turn Sangha off in Choose your depths/u);
    await expect(decline).toBeVisible();
    await page.getByText('Digital Sangha', { exact: true }).scrollIntoViewIfNeeded();
    await captureViewport(page, label, 'sangha');
    if (deviceScaleFactor === 2) {
      await decline.scrollIntoViewIfNeeded();
      await captureViewport(page, label, 'sangha-decline');
      await captureFullPage(page, label, 'sangha');
    }

    const vaultRow = page.getByTestId('settings-row-vault');
    await vaultRow.scrollIntoViewIfNeeded();
    await expect(vaultRow).toContainText('Sorting lets reflections reach beyond');
    const vaultRead = page.waitForResponse(
      (response) =>
        response.url().endsWith('/vault/connection') && response.request().method() === 'GET',
    );
    const activationRead = page.waitForResponse(
      (response) =>
        response.url().endsWith('/vault/activation') && response.request().method() === 'GET',
    );
    await vaultRow.click();
    await Promise.all([vaultRead, activationRead]);
    const vault = page.getByTestId('vault-settings-screen');
    await expectNoHorizontalClipping(vault);
    await expect(page.getByTestId('vault-higher-self-gain')).toHaveText(HIGHER_SELF_GAIN);
    for (const testId of [
      'vault-header',
      'vault-promise',
      'vault-what-it-is',
      'vault-higher-self-gain',
      'vault-floor',
      'vault-intimate',
    ]) {
      await expectNoHorizontalClipping(page.getByTestId(testId));
    }
    const deckOrder = await page
      .locator(
        '[data-testid="vault-higher-self-gain"], [data-testid="vault-promise"], ' +
          '[data-testid="vault-what-it-is"], [data-testid="vault-floor"]',
      )
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
    expect(deckOrder).toEqual([
      'vault-higher-self-gain',
      'vault-promise',
      'vault-what-it-is',
      'vault-floor',
    ]);
    await vault.evaluate((node) => {
      node.scrollTop = 0;
    });
    await captureViewport(page, label, 'vault');
    if (deviceScaleFactor === 2) {
      for (const testId of ['vault-floor', 'vault-intimate']) {
        await page.getByTestId(testId).scrollIntoViewIfNeeded();
        await captureViewport(page, label, testId);
      }
      await captureFullPage(page, label, 'vault');
    }
  } finally {
    await context.close();
  }
}

test('Settings leads with each gain without clipping or hiding a switch', async ({ browser }) => {
  await exercise(browser, '390x844-100', { width: 390, height: 844 });
  // A 195x422 CSS viewport rendered into 390x844 physical pixels.
  await exercise(browser, '390x844-200', { width: 195, height: 422 }, 2);
  await exercise(browser, '1280x800-100', { width: 1280, height: 800 });
});
