import { expect, test, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * A margin note says which side answered it, and still says so after a cold
 * reload (#3062).
 *
 * This lane serves the stub provider, whose canned note is a demo: the server
 * records ``source = demo`` on the row in the same commit as the note, and the
 * margin labels it. The reload is the claim that matters -- the label is read
 * back from what the server persisted, never re-derived from the pass that is
 * no longer in memory, and never from whether a vault is connected. The pass
 * runs through the screen's own button so the pass-level line is exercised as
 * well, and nobody is charged for it.
 *
 * Not claimed here: a vault-answered note's label. The lane's fake Creek vault
 * advertises no reflect capability, so that half is declared uncovered in
 * ``journeys.json`` and pinned by the backend suite.
 */

const PAGE_BODY = 'The heron stood in the shallows until the light changed.';
const DEMO = /^Demo/;

async function writeFinishedPage(page: Page, token: string): Promise<number> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'The heron', message: PAGE_BODY },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);
  return entryId;
}

async function monthlyUsed(page: Page, token: string): Promise<number> {
  const response = await page.request.get(`${backendUrl()}/user/usage`, {
    headers: bearer(token),
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { monthly_messages_used: number }).monthly_messages_used;
}

async function openEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
}

test('a demo note is labelled as a demo, before and after a cold reload', async ({ page }) => {
  const email = await signUp(page, 'journal-margin-note-source');
  const token = await tokenFor(page.request, email);
  const entryId = await writeFinishedPage(page, token);
  const usedBefore = await monthlyUsed(page, token);

  await openEntry(page, entryId);
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await page.getByTestId('resonance-explainer-continue').click();

  const label = page.locator('[data-testid^="margin-note-source-"]').first();
  await expect(label).toHaveText(DEMO);
  await expect(page.getByTestId('resonance-pass-source')).toHaveText(DEMO);
  expect(await monthlyUsed(page, token)).toBe(usedBefore);

  // A cold reload drops every in-memory pass; the web app reopens on the
  // journal home, so walk back to the page and read the margin fresh.
  await page.reload();
  await openEntry(page, entryId);
  await expect(page.locator('[data-testid^="margin-note-source-"]').first()).toHaveText(DEMO);
  // The pass-level line belongs to the pass, which a reload does not replay.
  await expect(page.getByTestId('resonance-pass-source')).toHaveCount(0);
});
