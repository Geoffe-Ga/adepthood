import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { WELCOME_PANELS } from '../src/features/Welcome/welcomeContent';

import { frontendUrl } from './journalHabitsBrowserSupport';
import { freshLicenseKey } from './licenseKey';

function uiFlagsRead(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === '/ui-flags',
  );
}

/** Enter through real signup and verify this account has not seen the welcome. */
async function arriveAtWelcome(page: Page): Promise<void> {
  await page.goto(`${frontendUrl()}/get-started`);
  await page.getByRole('button', { name: 'I have a license key' }).click();
  await page
    .getByRole('textbox', { name: 'Email' })
    .fill(`welcome-${randomBytes(6).toString('hex')}@example.com`);
  await page
    .getByRole('textbox', { name: 'Password', exact: true })
    .fill('Welcome-browser-passphrase');
  await page.getByRole('textbox', { name: 'Confirm password' }).fill('Welcome-browser-passphrase');
  await page.getByRole('textbox', { name: 'Gumroad license key' }).fill(freshLicenseKey());
  const flagsRead = uiFlagsRead(page);
  await page.getByRole('button', { name: 'Create account' }).click();
  const flags = await flagsRead;
  expect(flags.status()).toBe(200);
  expect(await flags.json()).toMatchObject({ has_seen_welcome: false });
  await expect(page.getByTestId('welcome-screen')).toBeVisible();
}

/** Verify and capture the persistent control for panel review. */
async function savePanelFrame(page: Page, path: string): Promise<void> {
  const skip = page.getByRole('button', { name: 'Skip the welcome' });
  // Capture the decline control separately for manual review and verify it remains actionable.
  await skip.screenshot({ path: path.replace('.png', '-skip.png'), animations: 'disabled' });
  await skip.click({ trial: true });
  await page.screenshot({ path, animations: 'disabled' });
}

/** Await the durable write before reload, then read the server-owned flag again. */
async function dismissAndVerify(page: Page, action: Locator): Promise<void> {
  const flagWrite = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === '/ui-flags' &&
      response.request().postDataJSON().has_seen_welcome === true,
  );
  const shelfRead = page.waitForResponse(
    (response) => response.request().method() === 'GET' && /\/journal\/\?/.test(response.url()),
  );
  await action.click();
  const saved = await flagWrite;
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({ has_seen_welcome: true });
  expect((await shelfRead).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  const restoredFlags = uiFlagsRead(page);
  await page.reload();
  const restored = await restoredFlags;
  expect(restored.status()).toBe(200);
  expect(await restored.json()).toMatchObject({ has_seen_welcome: true });
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  await expect(page.getByTestId('welcome-screen')).toHaveCount(0);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
]) {
  test(`all four Welcome panels fit and Begin reaches the Journal at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await arriveAtWelcome(page);
    const artifactDir = join(__dirname, 'artifacts', 'welcome', String(viewport.width));
    mkdirSync(artifactDir, { recursive: true });

    for (const [index, content] of WELCOME_PANELS.entries()) {
      const panel = page.getByTestId(`welcome-panel-${index}`);
      await expect(panel.getByText(content.body, { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: 'Skip the welcome' })).toBeInViewport({
        ratio: 1,
      });
      if (content.note) {
        await expect(panel.getByText(content.note, { exact: true })).toBeInViewport({ ratio: 1 });
        await expect(panel.getByText('Map', { exact: true })).toBeInViewport({ ratio: 1 });
      }
      const action = page.getByRole('button', {
        name: index === WELCOME_PANELS.length - 1 ? 'Begin the journey' : 'Next panel',
      });
      await expect(action).toBeInViewport({ ratio: 1 });
      await savePanelFrame(page, join(artifactDir, `panel-${index}.png`));
      if (index < WELCOME_PANELS.length - 1) await action.click();
    }
    await dismissAndVerify(page, page.getByRole('button', { name: 'Begin the journey' }));
  });
}

test('Skip persists and reaches the Journal without paging', async ({ page }) => {
  await arriveAtWelcome(page);
  await dismissAndVerify(page, page.getByRole('button', { name: 'Skip the welcome' }));
});

/** Browser equivalent of enlarged text: preserve each text style's relative size. */
async function enlargeWelcomeText(page: Page): Promise<void> {
  await page.getByTestId('welcome-screen').evaluate((root) => {
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.childElementCount || !element.textContent?.trim()) continue;
      const computed = getComputedStyle(element);
      element.style.fontSize = `${parseFloat(computed.fontSize) * 2}px`;
      element.style.lineHeight = `${parseFloat(computed.lineHeight) * 2}px`;
    }
  });
}

/** A long paragraph need not fit at once, but its final words must be reachable. */
async function expectLastWordsInPanel(text: Locator, panel: Locator): Promise<void> {
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  const lastLine = await text.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node;
    if (!last?.textContent) throw new Error('Expected a rendered paragraph');
    const range = document.createRange();
    range.setStart(last, last.textContent.length - 1);
    range.setEnd(last, last.textContent.length);
    const rect = range.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
  expect(lastLine.top).toBeGreaterThanOrEqual(bounds!.y);
  expect(lastLine.bottom).toBeLessThanOrEqual(bounds!.y + bounds!.height);
}

for (const scenario of [
  { name: 'short-phone', width: 320, height: 568, enlarged: false },
  { name: '200-percent-text', width: 390, height: 844, enlarged: true },
]) {
  test(`all Welcome content is reachable with persistent controls: ${scenario.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await arriveAtWelcome(page);
    if (scenario.enlarged) await enlargeWelcomeText(page);
    const artifacts = join(__dirname, 'artifacts', 'welcome', scenario.name);
    mkdirSync(artifacts, { recursive: true });

    for (const [index, content] of WELCOME_PANELS.entries()) {
      const panel = page.getByTestId(`welcome-panel-${index}`);
      await expect(panel.getByRole('heading', { name: content.title })).toBeInViewport({
        ratio: 1,
      });
      await savePanelFrame(page, join(artifacts, `panel-${index}-top.png`));
      await panel.hover();
      await page.mouse.wheel(0, 10_000);
      await expect
        .poll(() => panel.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThanOrEqual(1);
      await expectLastWordsInPanel(
        panel.getByText(content.note ?? content.body, { exact: true }),
        panel,
      );
      if (content.note)
        await expect(panel.getByTestId('welcome-privacy-note')).toBeInViewport({ ratio: 1 });
      const action = page.getByRole('button', {
        name: index === WELCOME_PANELS.length - 1 ? 'Begin the journey' : 'Next panel',
      });
      await expect(action).toBeInViewport({ ratio: 1 });
      await savePanelFrame(page, join(artifacts, `panel-${index}-bottom.png`));
      if (index < WELCOME_PANELS.length - 1) await action.click();
    }
    await dismissAndVerify(page, page.getByRole('button', { name: 'Begin the journey' }));
  });
}
