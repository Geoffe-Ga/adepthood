import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { readBrowserLaneState } from './browserState';

const ACCOUNT_PHRASE = 'Browser-QA-2652-passphrase';
const LICENSE_KEY = 'browser-qa-license-2652';
const PASSAGE_INPUT = 'textarea[data-testid="passage-select-input"]';

function frontendUrl(): string {
  const state = readBrowserLaneState();
  if (state === null) throw new Error('browser E2E state is missing; global setup did not run');
  return state.frontendUrl;
}

async function signUpAndOpenChapter(page: Page): Promise<void> {
  const email = `browser-2652-${randomBytes(6).toString('hex')}@example.com`;
  await page.goto(`${frontendUrl()}/get-started`);
  await page.getByRole('button', { name: 'I have a license key' }).click();
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(ACCOUNT_PHRASE);
  await page.getByRole('textbox', { name: 'Confirm password' }).fill(ACCOUNT_PHRASE);
  await page.getByRole('textbox', { name: 'Gumroad license key' }).fill(LICENSE_KEY);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Skip the welcome' }).click();
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Course', exact: true }).click();
  await page.getByRole('button', { name: 'What is Beige?', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Write a note on a passage' })).toBeVisible();
}

async function enterSelectionMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Write a note on a passage' }).click();
  await expect(page.locator(PASSAGE_INPUT)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write a note', exact: true })).toBeDisabled();
}

async function cancelSelectionMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Cancel promoting' }).click();
  await expect(page.getByRole('button', { name: 'Write a note on a passage' })).toBeVisible();
}

async function expectSelectionEnabled(page: Page): Promise<void> {
  const preview = page.locator('[data-testid="passage-select-preview"]');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(/\S/u);
  await expect(page.getByRole('button', { name: 'Write a note', exact: true })).toBeEnabled();
}

test('a course passage can become a saved journal note with every desktop selection gesture', async ({
  page,
}) => {
  await signUpAndOpenChapter(page);

  await enterSelectionMode(page);
  const input = page.locator(PASSAGE_INPUT);
  await input.click({ position: { x: 24, y: 24 } });
  await input.press('Home');
  await input.press('Shift+ArrowRight');
  await input.press('Shift+ArrowRight');
  await input.press('Shift+ArrowRight');
  await expectSelectionEnabled(page);
  await cancelSelectionMode(page);

  await enterSelectionMode(page);
  await page.locator(PASSAGE_INPUT).dblclick({ position: { x: 20, y: 24 } });
  await expectSelectionEnabled(page);
  await cancelSelectionMode(page);

  await enterSelectionMode(page);
  const dragInput = page.locator(PASSAGE_INPUT);
  const box = await dragInput.boundingBox();
  if (box === null) throw new Error('the passage textarea has no layout box');
  await page.mouse.move(box.x + 8, box.y + 24);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 24, { steps: 8 });
  await page.mouse.up();
  await expectSelectionEnabled(page);

  await page.getByRole('button', { name: 'Write a note', exact: true }).click();
  await expect(page.getByText('Write a note on this passage?')).toBeVisible();
  await page.getByTestId('write-note-dialog-confirm').click();

  const body = page.getByRole('textbox', { name: 'Entry body' });
  await expect(body).toHaveValue(/^> /);
  await page.getByRole('textbox', { name: 'Entry title' }).fill('A saved passage note');
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
});
