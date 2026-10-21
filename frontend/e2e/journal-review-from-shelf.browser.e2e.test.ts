import { expect, test } from '@playwright/test';

import {
  backendUrl,
  setProgramAnchorDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';
import { openPrompts } from './journalHabitsBrowserSupport';

/** Program day 7: the first week closes, so its review is the shelf's call to write. */
const DAY_SEVEN = 6;
/** Program day 9: nothing is due, but the second week, stage 1, section 1 and the course are open. */
const DAY_NINE = 8;

interface SavedEntry {
  id: number;
  tag: string;
  reflection_level: string | null;
  reflection_scope_key: string | null;
}

test('on a review day the shelf’s one call to write is the Weekly Review', async ({ page }) => {
  const email = await signUp(page, 'review-cta-day-seven');
  setProgramAnchorDaysAgo(email, DAY_SEVEN);
  await page.reload();
  await openPrompts(page);

  const cta = page.getByRole('button', { name: /^Write your Weekly Review/ });
  await expect(cta).toBeVisible();
  // One primary invitation: the daily page steps aside while the review is offered.
  await expect(page.getByRole('button', { name: 'Begin a page of morning pages' })).toHaveCount(0);
  await cta.click();

  await expect(page.getByRole('textbox', { name: 'Entry title' })).toHaveValue(
    'Weekly Review — Week 1',
  );
});

for (const width of [390, 1280]) {
  test(`the early-review card explains reviews and starts or resumes one at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, 'review-early-day-nine');
    const token = await tokenFor(page.request, email);
    const headers = { Authorization: `Bearer ${token}` };
    setProgramAnchorDaysAgo(email, DAY_NINE);
    await page.reload();
    await openPrompts(page);

    // Nothing is due on day 9, so the daily page holds the primary slot.
    await expect(page.getByRole('button', { name: 'Begin a page of morning pages' })).toBeVisible();
    await expect(page.getByTestId('journal-reflection-band')).toHaveCount(0);

    const card = page.getByTestId('journal-review-early-card');
    await expect(card.getByText('Review your Morning Pages', { exact: true })).toBeVisible();
    await expect(card).toContainText('carrying quotes from daily entries into broader learnings');
    await expect(card).toContainText(
      'this week, this stage, this trimester, or across the whole course',
    );
    const action = card.getByRole('button', { name: /^Start a review early/ });
    await action.scrollIntoViewIfNeeded();
    const geometry = await card.evaluate((element) => {
      const morning = document.querySelector('[data-testid="journal-morning-pages-band"]');
      const button = element.querySelector('[data-testid="journal-review-early"]');
      if (!(morning instanceof HTMLElement) || !(button instanceof HTMLElement)) return null;
      const bounds = element.getBoundingClientRect();
      const actionBounds = button.getBoundingClientRect();
      const style = getComputedStyle(element);
      const morningStyle = getComputedStyle(morning);
      return {
        raised: style.backgroundColor === morningStyle.backgroundColor,
        rule:
          style.borderLeftColor === morningStyle.borderLeftColor &&
          parseFloat(style.borderLeftWidth) > 0,
        radius:
          style.borderRadius === morningStyle.borderRadius && parseFloat(style.borderRadius) > 0,
        contained:
          actionBounds.left >= bounds.left &&
          actionBounds.right <= bounds.right &&
          actionBounds.top >= bounds.top &&
          actionBounds.bottom <= bounds.bottom,
        touchHeight: actionBounds.height,
        withinViewport: bounds.left >= 0 && bounds.right <= window.innerWidth,
      };
    });
    expect(geometry).toMatchObject({
      raised: true,
      rule: true,
      radius: true,
      contained: true,
      withinViewport: true,
    });
    expect(geometry?.touchHeight).toBeGreaterThanOrEqual(44);
    const screenshotPath = testInfo.outputPath('early-review-card.png');
    await card.screenshot({ path: screenshotPath });
    await testInfo.attach('early-review-card', { path: screenshotPath, contentType: 'image/png' });

    await action.click();
    await expect(card.getByTestId('journal-review-scope-section')).toBeVisible();
    await card.getByTestId('journal-review-scope-week').click();

    const title = page.getByRole('textbox', { name: 'Entry title' });
    await expect(title).toHaveValue('Weekly Review — Week 2');
    await page.getByRole('textbox', { name: 'Entry body' }).fill('Halfway through week two.');
    await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');

    const saved = await page.request.get(`${backendUrl()}/journal/`, { headers });
    const { items } = (await saved.json()) as { items: SavedEntry[] };
    const review = items.find((entry) => entry.reflection_scope_key === 'c1:w2');
    expect(review).toEqual(
      expect.objectContaining({ tag: 'hierarchical_reflection', reflection_level: 'week' }),
    );

    // Back on the shelf, the picker offers to CONTINUE that review rather than
    // start a second one, and pressing it reopens the very page just written.
    await page.getByTestId('journal-close-entry').click();
    await openPrompts(page);
    await page.getByRole('button', { name: /^Start a review early/ }).click();
    const continueRow = page.getByRole('button', { name: /^Continue — Weekly Review — Week 2/ });
    await expect(continueRow).toBeVisible();
    await continueRow.click();
    await expect(page.getByRole('textbox', { name: 'Entry body' })).toHaveValue(
      'Halfway through week two.',
    );
    await expect(page.getByRole('textbox', { name: 'Entry title' })).toHaveValue(
      'Weekly Review — Week 2',
    );
    const after = await page.request.get(`${backendUrl()}/journal/`, { headers });
    const { items: afterItems } = (await after.json()) as { items: SavedEntry[] };
    expect(afterItems.filter((entry) => entry.reflection_scope_key === 'c1:w2')).toEqual([
      expect.objectContaining({ id: review?.id }),
    ]);
  });
}
