import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  backendUrl,
  bearer,
  openPrompts,
  setProgramAnchorSixDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * The review Sources' floating "Promote a quote" (#3718).
 *
 * A writer reviewing a week expands a long source and reads about 2000px down
 * it. "Promote a quote" stays fixed at the foot of the panel, outside its
 * scroll, in the bounded bottom sheet on a phone and the centred modal on a
 * laptop. Pressing it there opens the selection in that source and focuses the
 * field, and the panel's scroll offset stays exactly where it was.
 */

const PHONE = { width: 390, height: 844 } as const;
const LAPTOP = { width: 1280, height: 720 } as const;
/** Lines in the long source: comfortably more than DEEP_OFFSET_PX of text. */
const SOURCE_LINES = 120;
/** How far into the panel's scroll the writer has read before promoting. */
const DEEP_OFFSET_PX = 2000;
/** Sub-pixel rounding allowance on a scroll offset. */
const EPSILON_PX = 1;
const DRAFT = 'Looking back on the week.';

const visible = (page: Page, testId: string): Locator =>
  page.locator(`[data-testid="${testId}"]:visible`);

/** Sign up, seed one long finished source in the review week, open Sources and expand it. */
async function expandLongSource(page: Page, prefix: string): Promise<number> {
  const email = await signUp(page, prefix);
  const headers = bearer(await tokenFor(page.request, email));
  setProgramAnchorSixDaysAgo(email);
  const lines = Array.from(
    { length: SOURCE_LINES },
    (_unused, index) => `Line ${index + 1}: I walked beside the river.`,
  );
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    // Blank lines between, so read mode renders a paragraph per line rather
    // than one merged paragraph shorter than DEEP_OFFSET_PX.
    data: { title: 'A long walk', message: lines.join('\n\n') },
  });
  expect(created.ok()).toBe(true);
  const sourceId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${sourceId}`, {
    headers,
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);
  await page.reload();
  await openPrompts(page);
  await page.getByTestId('journal-reflection-band').click();
  await visible(page, 'journal-body-input').fill(DRAFT);
  await expect(visible(page, 'journal-save-hint')).toHaveText('Saved');
  await visible(page, 'reflection-sources-toggle').click();
  await visible(page, `entry-source-${sourceId}`).click();
  await expect(visible(page, `source-body-${sourceId}`)).toBeVisible();
  return sourceId;
}

for (const viewport of [PHONE, LAPTOP]) {
  test(`at ${viewport.width}x${viewport.height} Promote a quote floats at the panel's foot and opens selection without moving the scroll`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const sourceId = await expandLongSource(page, `promote-opener-${viewport.width}`);
    const scroller = visible(page, 'reflection-sources-scroll');
    const opener = visible(page, `source-promote-entry-${sourceId}`);

    // Outside the scroll, so no depth in the source can carry it away.
    await expect(scroller.getByTestId(`source-promote-entry-${sourceId}`)).toHaveCount(0);
    // ``scrollTop``, not ``scrollTo``: react-native-web replaces the ScrollView
    // node's ``scrollTo`` with its own ``{ x, y }`` signature.
    await scroller.evaluate((element, offset) => {
      element.scrollTop = offset;
    }, DEEP_OFFSET_PX);
    const before = await scroller.evaluate((element) => element.scrollTop);
    expect(before).toBeGreaterThanOrEqual(DEEP_OFFSET_PX - EPSILON_PX);
    await expect(opener).toBeInViewport();
    await expect(opener).toHaveAccessibleName('Promote a passage from A long walk');

    // A pointer press at its place on screen, with no locator scroll.
    const box = await opener.boundingBox();
    if (box === null) throw new Error('expected a laid-out opener');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    const field = visible(page, `source-select-entry-${sourceId}-input`);
    await expect(field).toBeFocused();
    await expect(opener).toHaveCount(0);
    const after = await scroller.evaluate((element) => element.scrollTop);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(EPSILON_PX);
  });
}
