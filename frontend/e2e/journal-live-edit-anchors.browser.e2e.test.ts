import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import {
  askForResonance,
  backendUrl,
  bearer,
  setProgramAnchorSixDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * Quote and margin anchors stay on the writer's own words through the live
 * editor, end to end (#2891).
 *
 * The writer types formatted Unicode -- a decomposed accent, a ZWJ emoji
 * sequence the server strips, bold typed key by key, italics, underline, an
 * escaped marker, a nested bullet, a leading newline and trailing spaces -- and
 * finishes. Read mode must then promote into the body the server STORED, and a
 * selection's trailing space must not reach the stored span. The quotes are
 * folded into a review (rendering as quote blocks in the live mirror at once,
 * one blank line between them), the source is edited before every anchor by
 * typing and by a list indent, and on reopen each anchor still addresses
 * exactly its own text or is honestly listed apart.
 */

const TITLE = 'River morning';
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const BEFORE_TYPED = `\nCafé at dawn ${FAMILY} walked by `;
const TYPED_BOLD = '**the river**';
const AFTER_TYPED =
  ' and _soft_ <u>light</u>, a \\*star\\*.\n- top.\n  - nested line.\n\nI keep this line close.  ';
const TYPED = `${BEFORE_TYPED}${TYPED_BOLD}${AFTER_TYPED}`;
/** Selected with its trailing space, which the stored span must not keep. */
const FIRST_SELECTION = 'walked by **the river** ';
const FIRST_QUOTE = 'walked by **the river**';
const SECOND_QUOTE = 'nested line';
const KEPT_QUOTE = 'at dawn';
const NOTE_SENTENCE = 'I keep this line close.';
const INSERTED = '_New_ start. ';

interface Quote {
  id: number;
  anchor_start: number;
  anchor_end: number;
  anchor_text: string;
  pending: boolean;
  stale: boolean;
}

interface Note {
  id: number;
  anchor_start: number;
  anchor_end: number;
  anchor_text: string;
  status: string;
}

/** The code-point slice the server would take: the anchor API's unit. */
function slice(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('');
}

async function storedBody(request: APIRequestContext, token: string, id: number): Promise<string> {
  const response = await request.get(`${backendUrl()}/journal/${id}`, { headers: bearer(token) });
  return ((await response.json()) as { message: string }).message;
}

async function quotesOf(request: APIRequestContext, token: string, id: number): Promise<Quote[]> {
  const response = await request.get(`${backendUrl()}/journal/${id}/promotions`, {
    headers: bearer(token),
  });
  return (await response.json()) as Quote[];
}

async function notesOf(request: APIRequestContext, token: string, id: number): Promise<Note[]> {
  const response = await request.get(`${backendUrl()}/journal/${id}/marginalia`, {
    headers: bearer(token),
  });
  return ((await response.json()) as { items: Note[] }).items;
}

/**
 * Select ``[start, end)`` (UTF-16) in a textarea the way a keyboard user does:
 * place it, then extend and retract it by one, so the page hears a real
 * selection gesture rather than only a programmatic range.
 */
async function selectRange(page: Page, field: Locator, start: number, end: number): Promise<void> {
  await field.evaluate(
    (element, [from, to]) => {
      const area = element as HTMLTextAreaElement;
      area.focus();
      area.setSelectionRange(from!, to! - 1);
    },
    [start, end],
  );
  await page.keyboard.press('Shift+ArrowRight');
}

async function promote(page: Page, stored: string, selected: string): Promise<void> {
  await page.getByTestId('promote-quote-button').click();
  // The box is never ticked here, so every promote meets the explainer (#2864).
  await page.getByTestId('promote-explainer-continue').click();
  const surface = page.locator('textarea[data-testid="quote-select-input"]');
  await expect(surface).toHaveValue(stored);
  const start = stored.indexOf(selected);
  expect(start).toBeGreaterThanOrEqual(0);
  await selectRange(page, surface, start, start + selected.length);
  await expect(page.getByTestId('quote-select-preview')).toHaveText(selected.trim());
  await page.getByTestId('quote-select-confirm').click();
  await expect(page.getByTestId('quote-promotion-success')).toHaveText(
    'Promoted — find it any time under Promoted quotes',
  );
}

test('a live-edited entry keeps its quote and margin anchors on the writer’s own words', async ({
  page,
}) => {
  const email = await signUp(page, 'live-edit-anchors');
  const token = await tokenFor(page.request, email);
  setProgramAnchorSixDaysAgo(email);

  // -- Type formatted Unicode into the live editor and finish. --
  await page.getByTestId('journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill(TITLE);
  const field = page.getByTestId('journal-body-input');
  await field.click();
  await page.keyboard.insertText(BEFORE_TYPED);
  await page.keyboard.type(TYPED_BOLD);
  // Styled the moment the closing delimiter lands, with no blur.
  await expect(
    page.getByTestId('journal-body-mirror').locator('[data-testid^="journal-live-bold-"]'),
  ).toHaveText('the river');
  await page.keyboard.insertText(AFTER_TYPED);
  await expect(field).toHaveValue(TYPED);
  const sourceId = ((await (await created).json()) as { id: number }).id;
  await page.getByTestId('journal-finish-button').click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();

  const stored = await storedBody(page.request, token, sourceId);
  expect(stored).toBe(TYPED.normalize('NFC').replace(/‍/gu, '').trim());
  expect(stored).not.toBe(TYPED);

  // -- Promote three passages straight away, from the STORED body. --
  await promote(page, stored, FIRST_SELECTION);
  await promote(page, stored, SECOND_QUOTE);
  await promote(page, stored, KEPT_QUOTE);
  const promoted = await quotesOf(page.request, token, sourceId);
  const byText = new Map(promoted.map((q) => [q.anchor_text, q]));
  for (const text of [FIRST_QUOTE, SECOND_QUOTE, KEPT_QUOTE]) {
    const quote = byText.get(text);
    expect(quote).toBeDefined();
    expect(slice(stored, quote!.anchor_start, quote!.anchor_end)).toBe(text);
    expect(quote!.anchor_end - quote!.anchor_start).toBe(Array.from(text).length);
  }
  const first = byText.get(FIRST_QUOTE)!;
  const second = byText.get(SECOND_QUOTE)!;
  const kept = byText.get(KEPT_QUOTE)!;

  // -- A margin note, anchored by the server to the closing sentence. --
  await askForResonance(page);
  await expect(page.locator('[data-testid^="margin-note-"]').first()).toBeVisible();
  const [note] = await notesOf(page.request, token, sourceId);
  expect(note?.anchor_text).toBe(NOTE_SENTENCE);
  expect(slice(stored, note!.anchor_start, note!.anchor_end)).toBe(NOTE_SENTENCE);

  // -- Fold two quotes into the due review. --
  await page.reload();
  await page.getByTestId('journal-reflection-band').click();
  const review = page.getByRole('textbox', { name: 'Entry body' });
  await review.fill('Looking back on the week.');
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
  await page.locator('[data-testid="reflection-sources-toggle"]:visible').click();
  await page.locator(`[data-testid="pending-quote-${first.id}"]:visible`).click();
  // A quote block in the live mirror at once: no blur, no reopen.
  const mirrorQuotes = page
    .getByTestId('journal-body-mirror')
    .locator('[data-testid^="journal-live-quote-"]');
  await expect(mirrorQuotes).toHaveCount(2);
  await page.locator(`[data-testid="pending-quote-${second.id}"]:visible`).click();
  const firstBlock = `> ${FIRST_QUOTE}\n> — ${TITLE}`;
  const secondBlock = `> ${SECOND_QUOTE}\n> — ${TITLE}`;
  await expect(review).toHaveValue(
    `Looking back on the week.\n\n${firstBlock}\n\n${secondBlock}\n\n`,
  );
  await expect(mirrorQuotes).toHaveCount(4);
  await expect(page.locator('[data-testid="journal-save-hint"]:visible')).toHaveText('Saved');
  await expect
    .poll(async () => (await quotesOf(page.request, token, sourceId)).map((q) => [q.id, q.pending]))
    .toEqual(
      expect.arrayContaining([
        [first.id, false],
        [second.id, false],
        [kept.id, true],
      ]),
    );
  const journal = await page.request.get(`${backendUrl()}/journal/`, { headers: bearer(token) });
  const reviewId = (
    (await journal.json()) as {
      items: Array<{ id: number; reflection_scope_key: string | null }>;
    }
  ).items.find((entry) => entry.reflection_scope_key === 'c1:w1')?.id;

  // -- Edit the source before every anchor: typed formatting, then a list indent. --
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${sourceId}`).click();
  await page.getByTestId('journal-edit-button').click();
  await page.getByTestId('edit-confirm-edit').click();
  const source = page.getByTestId('journal-body-input');
  await source.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(0, 0);
  });
  await page.keyboard.type(INSERTED);
  const topLine = (await source.inputValue()).indexOf('- top');
  await source.evaluate((element, at) => {
    (element as HTMLTextAreaElement).setSelectionRange(at, at);
  }, topLine);
  await page.keyboard.press('Tab');
  await expect(source).toHaveValue(`${INSERTED}${stored.replace('- top', '  - top')}`);
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');

  // -- Reopen: every anchor on its own words, or listed apart. --
  const edited = await storedBody(page.request, token, sourceId);
  expect(edited).toBe(`${INSERTED}${stored.replace('- top', '  - top')}`.trim());
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${sourceId}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();

  const after = new Map((await quotesOf(page.request, token, sourceId)).map((q) => [q.id, q]));
  const moved = after.get(kept.id)!;
  expect(moved.stale).toBe(false);
  expect(moved.anchor_start).toBeGreaterThan(kept.anchor_start);
  expect(slice(edited, moved.anchor_start, moved.anchor_end)).toBe(KEPT_QUOTE);
  await expect(page.getByTestId(`quote-highlight-${kept.id}`)).toHaveText(KEPT_QUOTE);

  // Folded quotes keep frozen offsets that now address other words: never
  // washed over them, but listed apart and still removable.
  for (const folded of [first, second]) {
    await expect(page.getByTestId(`quote-highlight-${folded.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`stale-quote-${folded.id}`)).toBeVisible();
  }

  const [movedNote] = await notesOf(page.request, token, sourceId);
  expect(movedNote?.status).toBe('active');
  expect(slice(edited, movedNote!.anchor_start, movedNote!.anchor_end)).toBe(NOTE_SENTENCE);
  await expect(page.getByTestId(`highlight-${note!.id}`)).toHaveText(NOTE_SENTENCE);

  // -- The review still renders both quote blocks after reopening. --
  expect(reviewId).toBeDefined();
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${reviewId}`).click();
  await expect(
    page.getByTestId('journal-body-mirror').locator('[data-testid^="journal-live-quote-"]'),
  ).toHaveCount(4);
});
