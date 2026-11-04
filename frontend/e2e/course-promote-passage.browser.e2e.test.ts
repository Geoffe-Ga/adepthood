import { expect, test, type Page } from '@playwright/test';

import {
  backendUrl,
  bearer,
  frontendUrl,
  setProgramAnchorDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';
import {
  answerPromoteNote,
  chapterId,
  expectPromotedNotice,
  onlyQuote,
  openChapter,
  openPromotedQuotes,
  pressPromote,
  selectFirstLine,
} from './readingPromoteBrowserSupport';

/**
 * A reader on a phone promotes a passage of a Course chapter (#3660). Select a
 * passage opens the chapter's selection field; choosing a passage raises the
 * same floating pill a journal page uses -- Promote beside Write a note, over
 * the text, with nothing washed over by the reader's bottom fade -- and Promote
 * stores exactly the echoed words, at offsets into the chapter as served.
 *
 * Its second half is the way back: a Course quote's Open lands on its chapter
 * with the passage chosen, and on the web a passage screens down is brought
 * into view rather than left selected off-screen.
 */

const PHONE = { width: 390, height: 844 };
/** The Beige chapter several screens long; released on day ten of the stage. */
const LONG_CHAPTER = '“INHABIT (Do)”';
const DAYS_INTO_BEIGE = 11;
/** RESONANCE_BUTTON_CLEARANCE: the pill's lift above the foot of the scroll viewport. */
const PILL_LIFT_PX = 76;
/** The column is inset by the reader sheet's margins, so its centre is the screen's. */
const CENTRE_TOLERANCE_PX = 2;

/** Whether the line a textarea's selection starts on is inside the viewport (runs in the page). */
function passageOnScreen(node: Element): boolean {
  const area = node as HTMLTextAreaElement;
  const style = getComputedStyle(area);
  const copy = document.createElement('div');
  for (const property of Array.from(style)) {
    copy.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(copy.style, {
    position: 'absolute',
    visibility: 'hidden',
    height: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  });
  copy.textContent = area.value.slice(0, area.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  copy.appendChild(marker);
  document.body.appendChild(copy);
  const drawnAt = area.getBoundingClientRect().top + marker.offsetTop;
  copy.remove();
  return drawnAt > 0 && drawnAt < window.innerHeight;
}

/**
 * The landed pill's lift above the foot of the screen, its centre, and whether
 * it clears the pinned footer under it.
 */
async function pillGeometry(
  page: Page,
): Promise<{ bottomGap: number; centre: number; clearsFooter: boolean }> {
  const anchor = page.getByTestId('promote-selection-fab-anchor');
  // Its fade and settle share one progress: full opacity means it has landed.
  await expect.poll(() => anchor.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  const pill = await anchor.boundingBox();
  const footer = await page.locator('[data-testid="passage-select-footer"]').boundingBox();
  if (pill === null || footer === null) throw new Error('the pill or the footer has no box');
  return {
    bottomGap: PHONE.height - (pill.y + pill.height),
    centre: pill.x + pill.width / 2,
    clearsFooter: pill.y + pill.height <= footer.y,
  };
}

test('a reader promotes a passage of a chapter from the floating pill', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const email = await signUp(page, 'course-promote');
  const token = await tokenFor(page.request, email);
  const contentId = await chapterId(page, token);

  await openChapter(page);
  await expect(page.getByTestId('reader-bottom-fade')).toBeVisible();
  await page.getByRole('button', { name: 'Select a passage' }).click();
  // The fade stands down while selecting: nothing washes over the footer or pill.
  await expect(page.getByTestId('reader-bottom-fade')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Promote this passage' })).toHaveCount(0);

  const words = await selectFirstLine(page, 'passage-select');
  const promote = page.getByRole('button', { name: 'Promote this passage' });
  await expect(promote).toBeVisible();
  await expect(promote).toHaveText('Promote');
  await expect(page.getByRole('button', { name: 'Write a note on this passage' })).toHaveText(
    'Write a note',
  );
  const { bottomGap, centre, clearsFooter } = await pillGeometry(page);
  expect(Math.abs(bottomGap - PILL_LIFT_PX)).toBeLessThanOrEqual(1);
  expect(Math.abs(centre - PHONE.width / 2)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
  expect(clearsFooter).toBe(true);

  await pressPromote(page);
  await answerPromoteNote(page, 'Promote the passage', { dontShowAgain: false });
  await expectPromotedNotice(page);
  const stored = await onlyQuote(page, token, `/course/content/${contentId}/promotions`);
  expect(stored).toMatchObject({ source_kind: 'course', anchor_text: words });
  const served = await page.request.get(`${backendUrl()}/course/content/${contentId}/body`, {
    headers: bearer(token),
  });
  const { body_markdown: markdown } = (await served.json()) as { body_markdown: string };
  const listed = await page.request.get(`${backendUrl()}/promotions`, { headers: bearer(token) });
  const [row] = ((await listed.json()) as { items: { anchor_start: number; anchor_end: number }[] })
    .items;
  if (row === undefined) throw new Error('GET /promotions listed nothing');
  expect(Array.from(markdown).slice(row.anchor_start, row.anchor_end).join('')).toBe(words);

  // The reader stays in selection with the passage let go, and Done leaves it.
  await expect(page.locator('[data-testid="passage-select-preview"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Promote this passage' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to the chapter' }).click();
  await expect(page.getByRole('button', { name: 'Select a passage' })).toBeVisible();
});

test('Open on a quote from deep in a long chapter lands with the passage chosen and in view', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  const email = await signUp(page, 'course-promote-deep');
  setProgramAnchorDaysAgo(email, DAYS_INTO_BEIGE);
  const token = await tokenFor(page.request, email);
  const contentId = await chapterId(page, token, LONG_CHAPTER);
  const served = await page.request.get(`${backendUrl()}/course/content/${contentId}/body`, {
    headers: bearer(token),
  });
  const { body_markdown: markdown } = (await served.json()) as { body_markdown: string };
  // A whole sentence about seven tenths of the way down, promoted over the route.
  const from = markdown.indexOf('. ', Math.floor(markdown.length * 0.7)) + 2;
  const to = markdown.indexOf('.', from + 20) + 1;
  const promoted = await page.request.post(`${backendUrl()}/course/content/${contentId}/promote`, {
    headers: bearer(token),
    data: {
      anchor_start: Array.from(markdown.slice(0, from)).length,
      anchor_end: Array.from(markdown.slice(0, to)).length,
    },
  });
  expect(promoted.status()).toBe(201);
  const quote = (await promoted.json()) as { id: number; anchor_text: string };

  await page.goto(`${frontendUrl()}/journal`);
  await openPromotedQuotes(page);
  await page.getByTestId(`promoted-quote-${quote.id}`).click();
  const field = page.locator('textarea[data-testid="passage-select-input"]');
  await expect(field).toBeVisible();
  await expect(page.locator('[data-testid="passage-select-preview"]')).toHaveText(
    quote.anchor_text,
  );
  const fieldBox = await field.boundingBox();
  if (fieldBox === null) throw new Error('the selection field has no layout box');
  expect(fieldBox.height).toBeGreaterThan(PHONE.height * 3);
  // The passage itself is on screen: an unseen copy of the field, in its
  // computed style, measures how far down the field the passage is drawn.
  await expect.poll(async () => field.evaluate(passageOnScreen)).toBe(true);
  expect(
    await field.evaluate((node) => {
      const area = node as HTMLTextAreaElement;
      return area.value.slice(area.selectionStart, area.selectionEnd);
    }),
  ).toBe(quote.anchor_text);
});
