import { expect, test } from '@playwright/test';

import { signUp, tokenFor } from './journalHabitsBrowserSupport';
import {
  LETTER_PAGE_TITLE,
  expectPromotedNotice,
  onlyQuote,
  openLetter,
  openPromotedQuotes,
  pressPromote,
  seedLetter,
  selectFirstLine,
  startLetterPromote,
} from './readingPromoteBrowserSupport';

/**
 * A reader on a phone lifts a sentence from a letter their Higher Self wrote
 * them (#3660). A quiet "Promote a quote" under the letter -- offered only
 * once there is a letter -- opens the one-time note set inside the card (never
 * a dialog over the dialog), then swaps the letter for the selection field over
 * the same words. The floating pill promotes the passage over the letter route,
 * the card stays open with the shared notice, and Promoted quotes captions it
 * with the page the letter answered.
 */

const PHONE = { width: 390, height: 844 };

test('a reader promotes a passage of a letter and the card stays open', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const email = await signUp(page, 'letter-promote');
  const token = await tokenFor(page.request, email);
  const { entryId, noteId, essay: letter } = await seedLetter(page, token);

  await openLetter(page, entryId, noteId);
  const card = page.getByTestId('essay-modal');
  await card.getByRole('button', { name: 'Promote a quote from this letter' }).click();

  // The note is set in the card, in place of the letter: one card, no scrim on a scrim.
  await expect(card.getByTestId('promote-explainer-panel')).toBeVisible();
  await expect(page.getByTestId('promote-explainer-scrim')).toHaveCount(0);
  await expect(card.getByTestId('essay-text')).toHaveCount(0);
  await card.getByTestId('promote-explainer-continue').click();

  const field = page.locator('textarea[data-testid="letter-quote-select-input"]');
  await expect(field).toHaveValue(letter);
  const words = await selectFirstLine(page, 'letter-quote-select');
  await pressPromote(page);

  await expectPromotedNotice(page);
  await expect(card.getByTestId('essay-text')).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Promote a quote from this letter' }),
  ).toBeVisible();
  const stored = await onlyQuote(page, token, `/journal/marginalia/${noteId}/letter/promotions`);
  expect(stored).toMatchObject({ source_kind: 'letter', anchor_text: words });

  // The same letter on the Voice drafts shelf offers the same gesture.
  await card.getByTestId('essay-close').click();
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByTestId('journal-drawer-voice-drafts').click();
  await page.getByTestId(`voice-draft-${noteId}`).click();
  await expect(page.getByTestId('voice-draft-letter-text')).toHaveText(letter);
  await startLetterPromote(page, 'first time');
  await page.getByTestId('letter-quote-select-cancel').click();
  await expect(page.getByTestId('voice-draft-letter-text')).toBeVisible();
  await page.getByTestId('voice-draft-close').click();

  await openPromotedQuotes(page);
  const row = page.getByTestId(`promoted-quote-${stored.id}`);
  await expect(row).toContainText(words);
  await expect(row).toContainText(`From a letter · ${LETTER_PAGE_TITLE}`);
});
