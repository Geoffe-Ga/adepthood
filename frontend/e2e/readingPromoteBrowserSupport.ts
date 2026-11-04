import { expect, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl } from './journalHabitsBrowserSupport';

/**
 * Shared by the promote-from-a-reading journeys (#3660): a Course chapter's and
 * a Resonance Letter's passage promoted through the floating pill, then found
 * on Promoted quotes and folded into a review. Each journey has its own spec
 * (one spec covers one journey); the steps they share live here once.
 */

/** The chapter every reading journey promotes from: stage 1's first, open on day one. */
export const CHAPTER_TITLE = 'What is Beige?';
/** The page a seeded letter answers, and so the caption a letter quote carries. */
export const LETTER_PAGE_TITLE = 'The heron';
const LETTER_PAGE_BODY =
  'The heron stood in the shallows until the light changed. I watched it a long time.';

interface ContentRow {
  id: number;
  title: string;
}

/** The chapter's content id, read the way the Course list reads it. */
export async function chapterId(page: Page, token: string, title = CHAPTER_TITLE): Promise<number> {
  const listed = await page.request.get(`${backendUrl()}/course/stages/1/content`, {
    headers: bearer(token),
  });
  expect(listed.ok()).toBe(true);
  const body = (await listed.json()) as ContentRow[] | { items: ContentRow[] };
  const rows = Array.isArray(body) ? body : body.items;
  const row = rows.find((candidate) => candidate.title === title);
  if (row === undefined) throw new Error(`stage 1 lists no chapter titled ${title}`);
  return row.id;
}

/** Open a stage-1 chapter in the Course reader from the Journal menu. */
export async function openChapter(page: Page, title = CHAPTER_TITLE): Promise<void> {
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Course', exact: true }).click();
  await page.getByTestId('stage-pill-1').click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select a passage' })).toBeVisible();
}

/**
 * Select the first visual line of a selection field with the keyboard, the
 * way a desktop reader would, and return the echo: exactly the words a promote
 * will store.
 */
export async function selectFirstLine(page: Page, prefix: string): Promise<string> {
  const field = page.locator(`textarea[data-testid="${prefix}-input"]`);
  await expect(field).toBeVisible();
  await field.click({ position: { x: 24, y: 12 } });
  await field.press('Home');
  await field.press('Shift+End');
  const echo = page.locator(`[data-testid="${prefix}-preview"]`);
  await expect(echo).toContainText(/\S/u);
  return (await echo.innerText()).trim();
}

/**
 * Press the floating pill's Promote at its place on screen, as a reader's
 * pointer does. Not a locator click: that first scrolls its target into view,
 * and for a pill pinned to the foot of a scroll viewport that scroll moves the
 * page under the reader, which no real press does.
 */
export async function pressPromote(page: Page): Promise<void> {
  const pill = page.getByRole('button', { name: 'Promote this passage' });
  await expect(pill).toBeInViewport();
  const box = await pill.boundingBox();
  if (box === null) throw new Error('the Promote pill has no layout box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Answer the one-time promote note a fresh account meets: it must carry the
 * reading wording and ``goAhead`` on its go-ahead; ``dontShowAgain`` ticks the
 * box first, so the account's next promote goes straight through.
 */
export async function answerPromoteNote(
  page: Page,
  goAhead: string,
  { dontShowAgain }: { dontShowAgain: boolean },
): Promise<void> {
  await expect(page.getByTestId('promote-explainer-body')).toContainText(
    'the review covering the week you promote it',
  );
  if (dontShowAgain) await page.getByTestId('promote-explainer-dont-show').click();
  const proceed = page.getByTestId('promote-explainer-continue');
  await expect(proceed).toHaveText(goAhead);
  await proceed.click();
}

/** The notice every promote ends on, wherever it was made. */
export async function expectPromotedNotice(page: Page): Promise<void> {
  await expect(page.getByTestId('quote-promotion-success')).toHaveText(
    'Promoted — find it any time under Promoted quotes',
  );
}

/** Open the Journal menu's Promoted quotes door, from the Journal tab. */
export async function openPromotedQuotes(page: Page): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Promoted quotes' }).click();
  await expect(page.getByTestId('promoted-quotes-screen')).toBeVisible();
}

/** The one quote a source's own promotions route lists, as the server stored it. */
export async function onlyQuote(
  page: Page,
  token: string,
  path: string,
): Promise<{ id: number; anchor_text: string; source_kind: string }> {
  const listed = await page.request.get(`${backendUrl()}${path}`, { headers: bearer(token) });
  expect(listed.ok()).toBe(true);
  const quotes = (await listed.json()) as {
    id: number;
    anchor_text: string;
    source_kind: string;
  }[];
  expect(quotes).toHaveLength(1);
  const [quote] = quotes;
  if (quote === undefined) throw new Error(`${path} listed no quote`);
  return quote;
}

/**
 * A finished page with one margin note and its letter, written over the real
 * routes (the lane's demo provider writes both, for free). Returns the ids a
 * reader reaches the letter by, and the letter itself.
 */
export async function seedLetter(
  page: Page,
  token: string,
): Promise<{ entryId: number; noteId: number; essay: string }> {
  const headers = bearer(token);
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: LETTER_PAGE_TITLE, message: LETTER_PAGE_BODY },
  });
  expect(created.status()).toBe(201);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${entryId}`, {
    headers,
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);
  const pass = await page.request.post(`${backendUrl()}/journal/${entryId}/resonance`, {
    headers,
  });
  expect(pass.status()).toBe(200);
  const note = ((await pass.json()) as { marginalia: { id: number }[] }).marginalia[0];
  if (note === undefined) throw new Error('the resonance pass wrote no margin note');
  const letter = await page.request.post(`${backendUrl()}/journal/marginalia/${note.id}/essay`, {
    headers,
    data: { price_acknowledged: true, disclosed_route: 'app_provider' },
  });
  expect(letter.status()).toBe(200);
  const { essay } = (await letter.json()) as { essay: string | null };
  if (essay === null || essay === '') throw new Error('the letter came back empty');
  return { entryId, noteId: note.id, essay };
}

/** Open the seeded page from the shelf and its note's letter in the essay modal. */
export async function openLetter(page: Page, entryId: number, noteId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await page.getByTestId(`margin-note-open-${noteId}`).click();
  await expect(page.getByTestId('essay-modal').getByTestId('essay-text')).toBeVisible();
}

/** From an open letter: Promote a quote, through the note when it is due, to the selection field. */
export async function startLetterPromote(
  page: Page,
  note: 'first time' | 'dismissed',
): Promise<void> {
  await page.getByRole('button', { name: 'Promote a quote from this letter' }).click();
  if (note === 'first time') {
    await answerPromoteNote(page, 'Choose the passage', { dontShowAgain: false });
  }
  await expect(page.locator('textarea[data-testid="letter-quote-select-input"]')).toBeVisible();
}

/**
 * Highlight ``text`` -- its ``occurrence``-th rendering -- inside the element
 * with ``testId``, as a reader's drag across the rendered page leaves it: one
 * DOM Range over the rendered text nodes, made the document's selection
 * (#3661). The passage may cross text nodes (a bold word, a paragraph). Returns
 * what the browser now holds selected.
 */
export async function selectRenderedText(
  page: Page,
  testId: string,
  text: string,
  occurrence = 0,
): Promise<string> {
  return page.evaluate(
    ({ id, needle, nth }) => {
      const root = document.querySelector(`[data-testid="${id}"]`);
      if (root === null) throw new Error(`nothing is rendered as ${id}`);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        nodes.push(node as Text);
      }
      const joined = nodes.map((node) => node.data).join('');
      let at = -1;
      for (let seen = 0; seen <= nth; seen += 1) at = joined.indexOf(needle, at + 1);
      if (at < 0) throw new Error(`"${needle}" is not rendered ${nth + 1} time(s) in ${id}`);
      // The text node a joined offset falls in: the first that holds it, or
      // for an end the first that reaches it.
      const place = (offset: number, isEnd: boolean): [Text, number] => {
        let start = 0;
        for (const node of nodes) {
          const end = start + node.data.length;
          if (isEnd ? offset <= end : offset < end) return [node, offset - start];
          start = end;
        }
        throw new Error(`offset ${offset} is past the rendered text`);
      };
      const range = document.createRange();
      range.setStart(...place(at, false));
      range.setEnd(...place(at + needle.length, true));
      const selection = getSelection();
      if (selection === null) throw new Error('the document has no selection');
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    },
    { id: testId, needle: text, nth: occurrence },
  );
}

/** The selected passage's box on screen, or null once nothing is selected. */
export async function selectedBox(
  page: Page,
): Promise<{ top: number; bottom: number; left: number; right: number } | null> {
  return page.evaluate(() => {
    const selection = getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const { top, bottom, left, right } = selection.getRangeAt(0).getBoundingClientRect();
    return { top, bottom, left, right };
  });
}

/**
 * Press the rendered-selection pill's Promote at its place on screen, as a
 * reader's pointer does: a real mouse press, which must not collapse the
 * passage it is about to act on. ``name`` is its accessible name.
 */
export async function pressRenderedPill(page: Page, name: string): Promise<void> {
  const pill = page.getByRole('button', { name, exact: true });
  await expect(pill).toBeInViewport();
  await expect
    .poll(() =>
      page
        .getByTestId('promote-selection-fab-anchor')
        .evaluate((node) => getComputedStyle(node).opacity),
    )
    .toBe('1');
  const box = await pill.boundingBox();
  if (box === null) throw new Error('the Promote pill has no layout box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
