import { expect, test, type Page } from '@playwright/test';

import {
  backendUrl,
  bearer,
  frontendUrl,
  openPrompts,
  setProgramAnchorSixDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';
import {
  CHAPTER_TITLE,
  LETTER_PAGE_TITLE,
  answerPromoteNote,
  chapterId,
  expectPromotedNotice,
  onlyQuote,
  openChapter,
  openLetter,
  openPromotedQuotes,
  pressPromote,
  seedLetter,
  selectFirstLine,
  startLetterPromote,
} from './readingPromoteBrowserSupport';

/**
 * A reader lifts a sentence from a Course chapter, and one from a letter their
 * Higher Self wrote them, the same way they lift one from their own page
 * (#3660) -- then finds both on Promoted quotes and folds the chapter's into
 * the review covering the week they promoted it, from "From your reading"
 * (#3659). Everything between the pixels and the rows is production: the
 * selection field, the floating pill, the promote routes (#3658), the Sources
 * feed's reading_quotes, the splice and the inclusion PATCH.
 */

/** Open the week's review from Prompts, write its opening and let it save; returns its id. */
async function openReview(page: Page, token: string): Promise<number> {
  await page.goto(`${frontendUrl()}/journal`);
  await openPrompts(page);
  await page.getByTestId('journal-reflection-band').click();
  await page.getByRole('textbox', { name: 'Entry body' }).fill('Looking back on the week.');
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
  const listed = await page.request.get(`${backendUrl()}/journal/`, { headers: bearer(token) });
  const { items } = (await listed.json()) as {
    items: { id: number; reflection_scope_key: string | null }[];
  };
  const review = items.find((entry) => entry.reflection_scope_key === 'c1:w1');
  if (review === undefined) throw new Error('the week-one review was not saved');
  return review.id;
}

test('a chapter quote and a letter quote reach Promoted quotes, and the chapter one folds into the week’s review', async ({
  page,
}) => {
  const email = await signUp(page, 'promote-from-reading');
  const token = await tokenFor(page.request, email);
  // Day six of week one: the review covering today is due, so a quote promoted
  // today waits among its sources.
  setProgramAnchorSixDaysAgo(email);
  const contentId = await chapterId(page, token);
  const { entryId, noteId } = await seedLetter(page, token);
  await page.reload();

  // 1-2. A chapter: Select a passage, choose a sentence, Promote.
  await openChapter(page);
  await page.getByRole('button', { name: 'Select a passage' }).click();
  const chapterWords = await selectFirstLine(page, 'passage-select');
  await expect(page.getByRole('button', { name: 'Write a note on this passage' })).toBeVisible();
  await pressPromote(page);
  await answerPromoteNote(page, 'Promote the passage', { dontShowAgain: true });
  await expectPromotedNotice(page);
  const chapterQuote = await onlyQuote(page, token, `/course/content/${contentId}/promotions`);
  expect(chapterQuote).toMatchObject({ source_kind: 'course', anchor_text: chapterWords });
  await page.getByRole('button', { name: 'Back to the chapter' }).click();

  // 3. Promoted quotes names where it came from.
  await openPromotedQuotes(page);
  const chapterRow = page.getByTestId(`promoted-quote-${chapterQuote.id}`);
  await expect(chapterRow).toContainText(chapterWords);
  await expect(chapterRow).toContainText(`From “${CHAPTER_TITLE}”`);

  // 4. The review covering today offers it under From your reading; a tap folds it in.
  const reviewId = await openReview(page, token);
  await page.locator('[data-testid="reflection-sources-toggle"]:visible').click();
  const reading = page.locator('[data-testid="reading-quotes"]:visible');
  await expect(reading.getByTestId('reading-quotes-label')).toHaveText('From your reading');
  const offered = page.locator(`[data-testid="reading-quote-${chapterQuote.id}"]:visible`);
  await expect(offered).toContainText(chapterWords);
  await offered.click();
  const body = page.getByRole('textbox', { name: 'Entry body' }).last();
  await expect(body).toHaveValue(
    new RegExp(`> ${escapeRegExp(chapterWords)}\\n> — From “${escapeRegExp(CHAPTER_TITLE)}”`, 'u'),
  );
  await expect(page.locator('[data-testid="journal-save-hint"]:visible')).toHaveText('Saved');
  const folded = await page.request.get(`${backendUrl()}/promotions?status=included`, {
    headers: bearer(token),
  });
  expect(
    ((await folded.json()) as { items: { id: number; included_in_entry_id: number }[] }).items,
  ).toEqual([expect.objectContaining({ id: chapterQuote.id, included_in_entry_id: reviewId })]);

  // 5. A letter: Promote a quote under it, choose a line, Promote -- the card stays open.
  await openLetter(page, entryId, noteId);
  await startLetterPromote(page, 'dismissed');
  const letterWords = await selectFirstLine(page, 'letter-quote-select');
  await pressPromote(page);
  await expectPromotedNotice(page);
  await expect(page.getByTestId('essay-modal').getByTestId('essay-text')).toBeVisible();
  const letterQuote = await onlyQuote(
    page,
    token,
    `/journal/marginalia/${noteId}/letter/promotions`,
  );
  expect(letterQuote).toMatchObject({ source_kind: 'letter', anchor_text: letterWords });
  await page.getByTestId('essay-close').click();
  await openPromotedQuotes(page);
  const letterRow = page.getByTestId(`promoted-quote-${letterQuote.id}`);
  await expect(letterRow).toContainText(letterWords);
  await expect(letterRow).toContainText(`From a letter · ${LETTER_PAGE_TITLE}`);
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
