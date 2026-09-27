import { expect, test, type Page, type Request } from '@playwright/test';

import {
  backendUrl,
  bearer,
  setProgramAnchorSixDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

const SOURCE_TITLE = 'Morning walk';
const SOURCE_BODY = 'I walked by the river. The heron stood still. Rain came at noon.';
/** The three passages promoted from the source, in the order they sit in it. */
const PASSAGES = ['I walked by the river', 'The heron stood still', 'Rain came at noon'] as const;
const OPENING = 'Looking back on the week.';

/** The body block a folded passage becomes, exactly as the composer writes it. */
function block(passage: string): string {
  return `> ${passage}\n> — ${SOURCE_TITLE}`;
}

/** Every PATCH /promotions/{id} the page sends, recorded as (id, target entry). */
function recordInclusionMarks(page: Page): Array<{ id: number; target: unknown }> {
  const marks: Array<{ id: number; target: unknown }> = [];
  page.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname;
    const match = /^\/promotions\/(\d+)$/.exec(path);
    if (request.method() !== 'PATCH' || match == null) return;
    const payload = request.postDataJSON() as { included_in_entry_id: unknown };
    marks.push({ id: Number(match[1]), target: payload.included_in_entry_id });
  });
  return marks;
}

test('a writer checks several promoted quotes and folds them into the review at once', async ({
  page,
}) => {
  const email = await signUp(page, 'fold-selected-quotes');
  const headers = bearer(await tokenFor(page.request, email));
  setProgramAnchorSixDaysAgo(email);

  // One finished source with three passages promoted over the real API.
  const source = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: SOURCE_TITLE, message: SOURCE_BODY },
  });
  const sourceId = ((await source.json()) as { id: number }).id;
  await page.request.patch(`${backendUrl()}/journal/${sourceId}`, {
    headers,
    data: { status: 'finished' },
  });
  const quoteIds: number[] = [];
  for (const passage of PASSAGES) {
    const start = SOURCE_BODY.indexOf(passage);
    const promoted = await page.request.post(`${backendUrl()}/journal/${sourceId}/promote`, {
      headers,
      data: { anchor_start: start, anchor_end: start + passage.length },
    });
    expect(promoted.ok()).toBe(true);
    quoteIds.push(((await promoted.json()) as { id: number }).id);
  }
  const [firstId, secondId, thirdId] = quoteIds as [number, number, number];

  // Begin the due weekly review and let it save, so it has an id to fold into.
  await page.reload();
  await page.getByTestId('journal-reflection-band').click();
  const bodyField = page.getByRole('textbox', { name: 'Entry body' });
  await bodyField.fill(OPENING);
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
  const listed = await page.request.get(`${backendUrl()}/journal/`, { headers });
  const reflection = (
    (await listed.json()) as { items: Array<{ id: number; reflection_scope_key: string | null }> }
  ).items.find((entry) => entry.reflection_scope_key === 'c1:w1');
  expect(reflection).toBeDefined();
  const reflectionId = reflection?.id;

  const marks = recordInclusionMarks(page);
  await page.locator('[data-testid="reflection-sources-toggle"]:visible').click();
  await page.locator('[data-testid="pending-quotes-select-toggle"]:visible').click();

  // Rows are checkboxes now, and the browser reads their state from aria-checked.
  const row = (id: number) => page.locator(`[data-testid="pending-quote-${id}"]:visible`);
  await expect(row(firstId)).toHaveAttribute('role', 'checkbox');
  await expect(row(firstId)).toHaveAttribute('aria-checked', 'false');
  const action = page.locator('[data-testid="quote-fold-action"]:visible');
  await expect(action).toHaveAttribute('aria-disabled', 'true');

  // Checked out of order; the fold keeps the order the passages sit in.
  await row(thirdId).click();
  await row(firstId).click();
  await expect(row(firstId)).toHaveAttribute('aria-checked', 'true');
  await expect(row(thirdId)).toHaveAttribute('aria-checked', 'true');
  await expect(row(secondId)).toHaveAttribute('aria-checked', 'false');
  await expect(action).toHaveText('Fold 2 quotes into this review');
  await expect(action).toBeInViewport();
  await action.click();

  await expect(page.locator('[data-testid="journal-save-hint"]:visible')).toHaveText('Saved');
  await expect(bodyField.last()).toHaveValue(
    `${OPENING}\n\n${block(PASSAGES[0])}\n\n${block(PASSAGES[2])}\n\n`,
  );
  await expect
    .poll(() => [...marks].sort((a, b) => a.id - b.id))
    .toEqual([
      { id: firstId, target: reflectionId },
      { id: thirdId, target: reflectionId },
    ]);
  const saved = await page.request.get(`${backendUrl()}/journal/${reflectionId}`, { headers });
  // The server stores the body without its trailing blank line.
  expect(((await saved.json()) as { message: string }).message).toBe(
    `${OPENING}\n\n${block(PASSAGES[0])}\n\n${block(PASSAGES[2])}`,
  );
  // The folded rows read as folded; the unchecked one still waits.
  await expect(row(firstId)).toHaveAttribute('aria-disabled', 'true');
  await expect(row(secondId)).toHaveAttribute('aria-checked', 'false');

  // The Promoted quotes screen counts the move on its next read.
  await page.reload();
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Promoted quotes' }).click();
  await expect(page.getByText('Not yet in a review (1)')).toBeVisible();
  await expect(page.getByText('Used in a review (2)')).toBeVisible();
});
