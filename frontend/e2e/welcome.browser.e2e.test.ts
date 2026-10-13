import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { WELCOME_PANELS } from '../src/features/Welcome/welcomeContent';

import { frontendUrl } from './journalHabitsBrowserSupport';
import { freshLicenseKey } from './licenseKey';

/** Enter through the real signup screen, leaving the walkthrough undismissed. */
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
  await page.getByRole('button', { name: 'Create account' }).click();
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
      const skip = page.getByRole('button', { name: 'Skip the welcome' });
      await expect(skip).toBeInViewport({ ratio: 1 });
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

    const shelfRead = page.waitForResponse(
      (response) => response.request().method() === 'GET' && /\/journal\/\?/.test(response.url()),
    );
    await page.getByRole('button', { name: 'Begin the journey' }).click();
    expect((await shelfRead).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
    await expect(page.getByTestId('welcome-screen')).toHaveCount(0);
  });
}

test('Skip persists and reaches the Journal without paging', async ({ page }) => {
  await arriveAtWelcome(page);
  const shelfRead = page.waitForResponse(
    (response) => response.request().method() === 'GET' && /\/journal\/\?/.test(response.url()),
  );
  await page.getByRole('button', { name: 'Skip the welcome' }).click();
  expect((await shelfRead).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  await expect(page.getByTestId('welcome-screen')).toHaveCount(0);
});
