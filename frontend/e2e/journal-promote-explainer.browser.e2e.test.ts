import { expect, test, type Page } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * The first "Promote a quote" explains itself, in a real browser (#2864).
 *
 * Jest pins the gate's timing and the per-account key. What only a rendered
 * app over a live server can settle is the promise the note makes: that a
 * promoted passage really is waiting where the note says — under Promoted
 * quotes in the Journal menu — and that the notice after a promote names that
 * same place and is announced. The spec also proves the "Don’t show this
 * again" answer is written under this account's key and survives a cold reload.
 */

const PAGE = 'I walked beside the river and noticed the light on the water.';
const PASSAGE = 'noticed the light on the water';
const NOTICE = 'Promoted — find it any time under Promoted quotes';
const DISMISSED_KEY_BASE = '@adepthood/promote_explainer_dismissed';

/** Select `passage` in the mirrored field the way a keyboard user does. */
async function selectPassage(page: Page, passage: string): Promise<void> {
  const field = page.locator('textarea[data-testid="quote-select-input"]');
  await expect(field).toHaveValue(PAGE);
  const start = PAGE.indexOf(passage);
  await field.evaluate(
    (element, [from, to]) => {
      const area = element as HTMLTextAreaElement;
      area.focus();
      area.setSelectionRange(from!, to! - 1);
    },
    [start, start + passage.length],
  );
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByTestId('quote-select-preview')).toHaveText(passage);
}

/** Every localStorage key this browser holds for the promote dismissal. */
async function dismissalKeys(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate((base) => {
    const found: Record<string, string | null> = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(base)) found[key] = window.localStorage.getItem(key);
    }
    return found;
  }, DISMISSED_KEY_BASE);
}

test('the first promote explains where a quote goes, and the quote is there', async ({ page }) => {
  const email = await signUp(page, 'promote-explainer');
  const headers = bearer(await tokenFor(page.request, email));
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: 'River light', message: PAGE },
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

  // 1. The first press explains, and asks for nothing yet.
  await page.getByTestId('promote-quote-button').click();
  const card = page.getByTestId('promote-explainer-card');
  await expect(card.getByRole('heading', { name: 'Promote a quote' })).toBeVisible();
  await expect(page.getByTestId('promote-explainer-body')).toContainText(
    'a review that covers the week you wrote it',
  );
  await expect(page.getByTestId('promote-explainer-body')).toContainText(
    'under Promoted quotes in the Journal menu',
  );
  const tick = card.getByRole('checkbox', { name: /Don’t show this note again/ });
  await expect(tick).not.toBeChecked();
  await expect(page.getByTestId('quote-select-input')).toHaveCount(0);
  // The two arms are equal: one row, the same size, neither easier to reach.
  const cancelBox = await page.getByTestId('promote-explainer-cancel').boundingBox();
  const proceedBox = await page.getByTestId('promote-explainer-continue').boundingBox();
  if (cancelBox === null || proceedBox === null) throw new Error('an arm has no layout box');
  expect(proceedBox.y).toBeCloseTo(cancelBox.y, 0);
  expect(proceedBox.width).toBeCloseTo(cancelBox.width, 0);
  expect(proceedBox.height).toBeCloseTo(cancelBox.height, 0);

  // 2. "Not now" is a real decline: no field, nothing remembered.
  await page.getByTestId('promote-explainer-cancel').click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('quote-select-input')).toHaveCount(0);
  expect(await dismissalKeys(page)).toEqual({});

  // 3. Asked again, the note is back; tick the box and choose the passage.
  await page.getByTestId('promote-quote-button').click();
  await tick.click();
  await expect(tick).toBeChecked();
  await page.getByRole('button', { name: 'Choose the passage to promote' }).click();
  await expect(card).toHaveCount(0);
  // The button that opened the note has gone with the read controls, so focus
  // is handed to the field the reader selects in rather than dropped on <body>.
  await expect(page.locator('textarea[data-testid="quote-select-input"]')).toBeFocused();
  await selectPassage(page, PASSAGE);
  const promoteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/journal/${entryId}/promote`,
  );
  const [promoted] = await Promise.all([
    promoteResponse,
    page.getByTestId('quote-select-confirm').click(),
  ]);
  expect(promoted.ok()).toBe(true);
  const quoteId = ((await promoted.json()) as { id: number }).id;

  // 4. The notice names where the quote went, and a screen reader hears it.
  const notice = page.getByTestId('quote-promotion-success');
  await expect(notice).toHaveText(NOTICE);
  await expect(notice).toHaveAttribute('aria-live', 'polite');

  // 5. The dismissal is this account's, not the device's.
  const keys = await dismissalKeys(page);
  expect(Object.keys(keys)).toHaveLength(1);
  const [[key, value]] = Object.entries(keys) as [[string, string | null]];
  expect(key).toMatch(new RegExp(`^${DISMISSED_KEY_BASE}#u\\d+$`, 'u'));
  expect(value).toBe('true');

  // 6. The place the note named is real: the quote is waiting there.
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Promoted quotes' }).click();
  await expect(page.getByText('Waiting for your next review (1)')).toBeVisible();
  await expect(page.getByTestId(`promoted-quote-${quoteId}`)).toContainText(PASSAGE);

  // 7. After a cold reload the answer holds: the press goes straight to selecting.
  await page.goto(new URL('/journal', page.url()).toString());
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await page.getByTestId('promote-quote-button').click();
  await expect(page.locator('textarea[data-testid="quote-select-input"]')).toBeFocused();
  await expect(page.getByTestId('promote-explainer-card')).toHaveCount(0);
});
