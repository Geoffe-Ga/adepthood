import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { readBrowserLaneState } from './browserState';

/**
 * The reflection hand-off, driven end to end in a real browser.
 *
 * A reader who finishes a chapter and taps "Reflect in Journal" lands on the
 * writing surface with the stage reflection's title already set, writes, and
 * then leaves the way they came in: "Back to reading" returns them to the
 * chapter rather than dropping them on the Journal shelf to find the Course tab
 * again by hand. That return only exists because the hand-off carries a
 * ``returnTo``, which is what this journey watches.
 *
 * It runs in the browser lane rather than the Node one because the whole
 * journey is screen-to-screen navigation: nothing about it is visible from the
 * wire, and the Node lane cannot mount a screen at all.
 */

const ACCOUNT_PHRASE = 'Browser-QA-2456-passphrase';
const LICENSE_KEY = 'browser-qa-license-2456';
const CHAPTER_TITLE = 'What is Beige?';
const REFLECTION = 'Beige is the floor everything else stands on.';

function frontendUrl(): string {
  const state = readBrowserLaneState();
  if (state === null) throw new Error('browser E2E state is missing; global setup did not run');
  return state.frontendUrl;
}

async function signUpAndOpenChapter(page: Page): Promise<void> {
  const email = `browser-2456-${randomBytes(6).toString('hex')}@example.com`;
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
  await page.getByRole('button', { name: CHAPTER_TITLE, exact: true }).click();
  await expect(page.getByTestId('chapter-reader')).toBeVisible();
}

/** Read to the end, which is where the reader offers its chapter controls. */
async function readToTheEnd(page: Page): Promise<void> {
  const reader = page.getByTestId('reader-markdown');
  await expect(reader).toBeVisible();
  await reader.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
}

test('a finished chapter reflection offers the way back to the reading it came from', async ({
  page,
}) => {
  await signUpAndOpenChapter(page);
  await readToTheEnd(page);

  await page.getByRole('button', { name: 'Mark as Read' }).click();
  const reflect = page.getByRole('button', { name: 'Reflect in Journal' });
  await expect(reflect).toBeVisible();
  await reflect.click();

  // The stage reflection opens titled for the chapter it came from.
  await expect(page.getByRole('textbox', { name: 'Entry title' })).toHaveValue(
    `Stage 1 reflection — ${CHAPTER_TITLE}`,
  );
  await page.getByRole('textbox', { name: 'Entry body' }).fill(REFLECTION);
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');

  // The point of the journey: an exit back to the chapter, not just to the shelf.
  const back = page.getByTestId('journal-return-to-reading');
  await expect(back).toBeVisible();
  await back.click();

  const reader = page.getByTestId('chapter-reader');
  await expect(reader).toBeVisible();
  // The same chapter, not merely the Course tab: the landing list behind the
  // reader carries this title too, so the assertion is scoped to the reader.
  await expect(reader.getByText(CHAPTER_TITLE).first()).toBeVisible();
});
