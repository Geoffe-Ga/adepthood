import { expect, test } from '@playwright/test';

import { backendUrl, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * The crisis-support note on a real distress signal (#2862, NORTH-STAR §10).
 *
 * The page is screened by the backend's local distress check, so the care
 * surface here is the server's own reviewed copy crossing the real route —
 * nothing about it is mocked. The pass runs on the lane's default (stub)
 * provider. What this spec proves, and Jest cannot (Jest has no layout):
 *
 * - the card opens on a short heading, with the two crisis lines first;
 * - the X removes the card and the journal page rises by the card's height,
 *   less the one reopen line that stays in its place;
 * - that line restores all four resources in one tap;
 * - Settings → Support & care still carries all four, whatever the note did.
 */

/** A page the local distress screen flags (see backend `domain.safety`). */
const DISTRESS_PAGE = 'I keep thinking I want to kill myself and end my life tonight.';

const CARE_TITLE = "You're not alone in this";

/** Layout rounds to whole pixels; allow one either way. */
const LAYOUT_SLACK_PX = 1;

const RESOURCE_KINDS = ['hotline', 'text_line', 'human', 'professional'];

test('the care note closes to one line, reopens in a tap, and Settings keeps the way back', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-care-support');
  const token = await tokenFor(page.request, email);
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'A heavy night', message: DISTRESS_PAGE },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;

  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await page.getByTestId('resonance-explainer-continue').click();

  // 1. The card opens on the short heading, crisis lines first.
  const card = page.getByTestId('care-support-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: CARE_TITLE })).toBeVisible();
  const kinds = await card
    .locator('[data-testid^="care-resource-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
  expect(kinds).toEqual(RESOURCE_KINDS.map((kind) => `care-resource-${kind}`));
  await expect(card.getByTestId('care-resource-hotline')).toContainText('988');
  await expect(card.getByTestId('care-resource-text_line')).toContainText('741741');

  // 2. Measure BEFORE the press, so the rise below is a real before/after.
  const page0 = await page.getByTestId('journal-page').boundingBox();
  const card0 = await card.boundingBox();
  if (page0 === null || card0 === null) throw new Error('the page and card must both be laid out');
  expect(card0.y).toBeLessThan(page0.y);

  await page.getByRole('button', { name: 'Hide the support note' }).click();

  // 3. The card is gone; one reopen line holds its place.
  await expect(page.getByTestId('care-support-card')).toHaveCount(0);
  await expect(page.locator('[data-testid^="care-resource-"]')).toHaveCount(0);
  const reopen = page.getByRole('button', { name: 'Show the support options again' });
  await expect(reopen).toBeVisible();
  await expect(reopen).toHaveText('Support options');
  const reopenBox = await reopen.boundingBox();
  const page1 = await page.getByTestId('journal-page').boundingBox();
  if (reopenBox === null || page1 === null) throw new Error('the reopen line must be laid out');
  expect(page0.y - page1.y).toBeGreaterThanOrEqual(
    card0.height - reopenBox.height - LAYOUT_SLACK_PX,
  );

  // 4. The way back is one tap.
  await reopen.click();
  await expect(page.getByTestId('care-support-card')).toBeVisible();
  await expect(page.locator('[data-testid^="care-resource-"]')).toHaveCount(RESOURCE_KINDS.length);

  // 5. And the permanent way back never depended on the note.
  await page.goto(`${frontendUrl()}/settings`);
  await page.getByTestId('settings-row-support').click();
  const screen = page.getByTestId('support-care-screen');
  await expect(screen).toBeVisible();
  for (const kind of RESOURCE_KINDS) {
    await expect(screen.getByTestId(`care-resource-${kind}`)).toBeVisible();
  }
});
