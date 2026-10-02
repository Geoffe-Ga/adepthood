import { expect, test, type Locator } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';

/** A phone held upright: below the 600px breakpoint, so the margin column stacks. */
const PHONE_VIEWPORT = { width: 390, height: 844 } as const;
/** Short filler lines that never wrap at phone width, for a body many screens tall. */
const FILLER_LINES = 120;
/** How many viewports tall the field must be, so the in-view checks cannot pass on a short body. */
const MIN_SCREENS = 3;
/** The body's last line: the passage a reader deep in the entry wants to promote. */
const CLOSING_LINE = 'the heron lifted off the far bank at dusk';
const CLOSING_KEY = 'heron';
const PROMOTED_COPY = 'Promoted — find it any time under Promoted quotes';
/** Keeps the drag's ends inside the line's glyphs rather than on the field's padding. */
const DRAG_INSET_PX = 4;
const DRAG_STEPS = 12;
const HALF = 2;

interface FieldGeometry {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Client y of the middle of the field's last line of text. */
  lastLineY: number;
  lineHeight: number;
}

function fieldGeometry(field: Locator): Promise<FieldGeometry> {
  return field.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const contentBottom = rect.bottom - Number.parseFloat(style.paddingBottom);
    return {
      top: rect.top,
      bottom: rect.bottom,
      left:
        rect.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
      right:
        rect.right -
        Number.parseFloat(style.borderRightWidth) -
        Number.parseFloat(style.paddingRight),
      lastLineY: contentBottom - lineHeight / 2,
      lineHeight,
    };
  });
}

async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('expected a laid-out element');
  return box.y;
}

test.use({ viewport: PHONE_VIEWPORT });

test('a reader deep in a long entry keeps Promote selection in view and promotes a passage near its end over the real wire', async ({
  page,
}) => {
  const email = await signUp(page, 'promote-long-entry');
  const headers = bearer(await tokenFor(page.request, email));
  const filler = Array.from({ length: FILLER_LINES }, (_, i) => `Line ${i + 1} of the walk.`);
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: 'Long walk', message: [...filler, CLOSING_LINE].join('\n') },
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
  await page.getByTestId('promote-quote-button').click();
  // A fresh account meets the one-time promote explainer first (#2864).
  await expect(page.getByTestId('promote-explainer-card')).toBeVisible();
  await page.getByRole('button', { name: 'Choose the passage to promote' }).click();

  const selection = page.locator('textarea[data-testid="quote-select-input"]');
  await expect(selection).toBeFocused();
  // No browser ring, and the field grows to its text instead of becoming an
  // inner scroll pane. Fonts are deliberately not awaited: a late reflow that
  // leaves the field short of its text is the bug this would catch.
  await expect
    .poll(() =>
      selection.evaluate((element) => ({
        outline: getComputedStyle(element).outlineStyle,
        fits: element.scrollHeight <= element.clientHeight,
      })),
    )
    .toEqual({ outline: 'none', fits: true });
  const opened = await fieldGeometry(selection);
  expect(opened.bottom - opened.top).toBeGreaterThan(PHONE_VIEWPORT.height * MIN_SCREENS);

  // With the field's top at the top of the screen, its end is screens away,
  // yet the footer sits at the foot of the viewport, pinned over the field.
  await selection.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const footer = page.getByTestId('quote-select-footer');
  const confirm = page.getByTestId('quote-select-confirm');
  await expect(footer).toBeInViewport();
  await expect(confirm).toBeInViewport();
  const footerBox = await footer.boundingBox();
  if (footerBox === null) throw new Error('the selection footer has no layout box');
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(PHONE_VIEWPORT.height);
  expect(footerBox.y).toBeLessThan((await fieldGeometry(selection)).bottom);

  // Bring the closing line toward mid-screen in one (possibly clamped) scroll,
  // then prove it landed on screen and clear of the footer before dragging.
  const before = await fieldGeometry(selection);
  await page
    .getByTestId('journal-page-scroll')
    .evaluate(
      (element, delta) => element.scrollBy(0, delta),
      before.lastLineY - PHONE_VIEWPORT.height / HALF,
    );
  const line = await fieldGeometry(selection);
  const footerTop = await topOf(footer);
  expect(line.lastLineY).toBeGreaterThanOrEqual(line.lineHeight);
  expect(line.lastLineY).toBeLessThanOrEqual(footerTop - line.lineHeight / HALF);

  await page.mouse.move(line.left + DRAG_INSET_PX, line.lastLineY);
  await page.mouse.down();
  await page.mouse.move(line.right - DRAG_INSET_PX, line.lastLineY, { steps: DRAG_STEPS });
  await page.mouse.up();
  const preview = page.getByTestId('quote-select-preview');
  await expect(preview).toContainText(CLOSING_KEY);
  const selectedText = (await preview.textContent())?.trim() ?? '';
  expect(CLOSING_LINE.includes(selectedText)).toBe(true);
  await expect(footer).toBeInViewport();
  await expect(confirm).toBeInViewport();

  const promoteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/journal/${entryId}/promote`,
  );
  const [promoted] = await Promise.all([promoteResponse, confirm.click()]);
  expect(promoted.ok()).toBe(true);
  await expect(page.getByTestId('quote-promotion-success')).toHaveText(PROMOTED_COPY);
  const promotions = await page.request.get(`${backendUrl()}/journal/${entryId}/promotions`, {
    headers,
  });
  expect(promotions.ok()).toBe(true);
  const quotes = (await promotions.json()) as Array<{ anchor_text: string }>;
  expect(quotes).toHaveLength(1);
  expect(quotes[0]?.anchor_text).toBe(selectedText);
});
