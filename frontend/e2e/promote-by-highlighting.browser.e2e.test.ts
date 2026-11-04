import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';
import {
  expectPromotedNotice,
  onlyQuote,
  openLetter,
  pressRenderedPill,
  seedLetter,
  selectRenderedText,
  selectedBox,
} from './readingPromoteBrowserSupport';

/**
 * Promote by highlighting, on the web (#3661): a reader at a laptop -- or a
 * phone's browser -- drags across a sentence where it is rendered, and the
 * floating Promote pill from #3134 comes to it with no selection field first.
 * Each passage is highlighted as a drag leaves it, with one DOM Range, and the
 * pill pressed at its place on screen, so the press itself must keep the
 * passage selected.
 *
 * A letter is covered here at both viewports: the pill rests where the card's
 * Promote a quote stood, which steps aside for it, so even the letter's
 * closing line stays readable, and the passage goes up over the letter route
 * exactly as the reader chose it. A journal page in read mode is covered for
 * the pill's own manners -- lifting a passage it would cover clear of it,
 * withdrawing while its passage is scrolled away, letting go from its X --
 * and, deep in a long entry, for the promote itself, under
 * journal.promote-a-passage-deep-in-a-long-entry.
 */

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 720 },
] as const;
const FAB = 'promote-selection-fab';
const LETTER_PROMOTE_A11Y = 'Promote this passage';
/** Sub-pixel rounding allowance on a box comparison. */
const EPSILON_PX = 1;
const HALF = 2;
/** A page long enough to scroll several screens at either viewport. */
const PAGE_LINES = 60;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('expected a laid-out element');
  return box;
}

/** The pill sits off the passage it acts on: wholly above it or wholly below it. */
async function expectPassageClearOf(page: Page, pill: Box): Promise<void> {
  const passage = await selectedBox(page);
  if (passage === null) throw new Error('nothing is selected');
  const clear = passage.bottom <= pill.y || passage.top >= pill.y + pill.height;
  expect(clear, `passage ${JSON.stringify(passage)} under pill ${JSON.stringify(pill)}`).toBe(true);
}

for (const viewport of VIEWPORTS) {
  test(`a reader highlights the closing line of a letter where it reads and promotes it (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const email = await signUp(page, `highlight-letter-${viewport.name}`);
    const token = await tokenFor(page.request, email);
    const { entryId, noteId, essay } = await seedLetter(page, token);
    await openLetter(page, entryId, noteId);
    const card = page.getByTestId('essay-modal');
    const opener = card.getByTestId('letter-promote-open');
    await expect(opener).toBeVisible();

    // The letter's last paragraph, highlighted right where it is rendered.
    const closing = essay.trim().split('\n\n').at(-1)?.trim() ?? '';
    expect(closing).not.toBe('');
    const words = await selectRenderedText(page, 'essay-text', closing);
    expect(words).toBe(closing);

    // The pill comes to it with no field opened, Promote a quote stepping
    // aside for it, and leaves the closing line readable.
    const pill = page.getByRole('button', { name: LETTER_PROMOTE_A11Y, exact: true });
    await expect(pill).toBeInViewport();
    await expect(pill).toContainText('Promote');
    await expect(page.locator('textarea[data-testid="letter-quote-select-input"]')).toHaveCount(0);
    await expect(
      card.getByRole('button', { name: 'Promote a quote from this letter' }),
    ).toHaveCount(0);
    await expect.poll(() => opener.evaluate((node) => getComputedStyle(node).opacity)).toBe('0');
    const pillBox = await boxOf(page.getByTestId(FAB));
    const clearBox = await boxOf(page.getByTestId(`${FAB}-cancel`));
    const letter = await boxOf(card.getByTestId('essay-text'));
    expect(
      Math.abs((pillBox.x + clearBox.x + clearBox.width) / HALF - (letter.x + letter.width / HALF)),
    ).toBeLessThanOrEqual(EPSILON_PX);
    await expectPassageClearOf(page, pillBox);

    // Pressed at its place, the passage stays chosen; the one-time note is set
    // in the card, worded for a passage already chosen, and goes ahead.
    await pressRenderedPill(page, LETTER_PROMOTE_A11Y);
    await expect(card.getByTestId('promote-explainer-panel')).toBeVisible();
    await expect(page.getByTestId('promote-explainer-scrim')).toHaveCount(0);
    const continueButton = card.getByTestId('promote-explainer-continue');
    await expect(continueButton).toHaveText('Promote the passage');
    const posted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/journal/marginalia/${noteId}/letter/promote`,
    );
    const [response] = await Promise.all([posted, continueButton.click()]);
    expect(response.ok()).toBe(true);

    // The card stays open on the letter, the notice beneath it and the opener
    // back in its place; the server holds exactly the words the reader chose.
    await expectPromotedNotice(page);
    await expect(card.getByTestId('essay-text')).toBeVisible();
    await expect(
      card.getByRole('button', { name: 'Promote a quote from this letter' }),
    ).toBeVisible();
    await expect(page.getByTestId(FAB)).toHaveCount(0);
    const stored = await onlyQuote(page, token, `/journal/marginalia/${noteId}/letter/promotions`);
    expect(stored).toMatchObject({ source_kind: 'letter', anchor_text: closing });
  });
}

/** A finished page of numbered lines, opened in read mode at a laptop's size. */
async function openLongPage(page: Page): Promise<{ entryId: number; token: string }> {
  await page.setViewportSize({ width: VIEWPORTS[1].width, height: VIEWPORTS[1].height });
  const email = await signUp(page, 'highlight-read-manners');
  const token = await tokenFor(page.request, email);
  const headers = bearer(token);
  const lines = Array.from({ length: PAGE_LINES }, (_, i) => `Walk ${i + 1}, by the water.`);
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: 'Walks', message: lines.join('\n') },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${entryId}`, {
    headers,
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
  return { entryId, token };
}

/** The first rendered line of the body that the resting pill would cover. */
function lineUnderPill(page: Page, pill: Box): Promise<string> {
  return page.getByTestId('journal-body-read').evaluate((element, band) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      const text = (node.textContent ?? '').trim();
      if (text !== '' && rect.top < band.y + band.height && rect.bottom > band.y) return text;
    }
    throw new Error('no line is drawn under the pill');
  }, pill);
}

test('the pill lifts a passage it would cover clear of it, withdraws while its passage is scrolled away, and lets go from its X', async ({
  page,
}) => {
  const { entryId, token } = await openLongPage(page);
  const scroller = page.getByTestId('journal-page-scroll');

  // A first passage brings the pill; a second, drawn right under the pill,
  // is lifted clear of it -- the page rises a breath, no more.
  await selectRenderedText(page, 'journal-body-read', 'Walk 2, by the water.');
  await expect(page.getByTestId(FAB)).toBeInViewport();
  const pill = await boxOf(page.getByTestId(FAB));
  const covered = await lineUnderPill(page, pill);
  const before = await scroller.evaluate((element) => element.scrollTop);
  await selectRenderedText(page, 'journal-body-read', covered);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before);
  await expect
    .poll(async () => (await selectedBox(page))?.bottom ?? Infinity)
    .toBeLessThanOrEqual((await boxOf(page.getByTestId(FAB))).y);
  await expectPassageClearOf(page, await boxOf(page.getByTestId(FAB)));

  // Scrolled out of view, the passage takes the pill with it; back, it returns.
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByTestId(FAB)).toHaveCount(0);
  await scroller.evaluate((element, top) => {
    element.scrollTop = top;
  }, before);
  await expect(page.getByTestId(FAB)).toBeInViewport();

  // Its X lets go of the passage: the pill leaves and nothing is promoted.
  const clear = await boxOf(page.getByTestId(`${FAB}-cancel`));
  await page.mouse.click(clear.x + clear.width / HALF, clear.y + clear.height / HALF);
  await expect(page.getByTestId(FAB)).toHaveCount(0);
  expect(await selectedBox(page)).toBeNull();
  const listed = await page.request.get(`${backendUrl()}/journal/${entryId}/promotions`, {
    headers: bearer(token),
  });
  expect(listed.ok()).toBe(true);
  expect(await listed.json()).toEqual([]);
});
