import { expect, test, type Locator } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';

/** A phone held upright: below the 600px breakpoint, so the margin column stacks. */
const PHONE_VIEWPORT = { width: 390, height: 844 } as const;
/** Short filler lines that never wrap at phone width, for a body many screens tall. */
const FILLER_LINES = 120;
/** How many viewports tall the field must be, so the in-view checks cannot pass on a short body. */
const MIN_SCREENS = 3;
/** The body's last line, so the field's end is unmistakable. */
const CLOSING_LINE = 'the heron lifted off the far bank at dusk';
const PROMOTED_COPY = 'Promoted — find it any time under Promoted quotes';
/** How far below the field's first line the promoted sentence lies (#3134). */
const DEEP_OFFSET_PX = 2000;
/**
 * ``RESONANCE_BUTTON_CLEARANCE`` (SPACING.xl + touchTarget.minimum + SPACING.md):
 * the floating pill's lift above the foot of the scroll viewport.
 */
const FLOATING_LIFT_PX = 76;
/** Sub-pixel rounding allowance on a box comparison. */
const EPSILON_PX = 1;
const FAB = 'promote-selection-fab';
/** Keeps the drag's ends inside the line's glyphs rather than on the field's padding. */
const DRAG_INSET_PX = 4;
const DRAG_STEPS = 12;
const HALF = 2;

interface FieldGeometry {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Client y of the top of the field's first line of text. */
  firstLineTop: number;
  lineHeight: number;
}

function fieldGeometry(field: Locator): Promise<FieldGeometry> {
  return field.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    return {
      top: rect.top,
      bottom: rect.bottom,
      left:
        rect.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
      right:
        rect.right -
        Number.parseFloat(style.borderRightWidth) -
        Number.parseFloat(style.paddingRight),
      firstLineTop:
        rect.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop),
      lineHeight,
    };
  });
}

async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('expected a laid-out element');
  return box;
}

test.use({ viewport: PHONE_VIEWPORT });

test('a reader selects a sentence 2000px down a long entry and promotes it from the floating pill without scrolling', async ({
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
  // yet the footer and its way out sit at the foot of the viewport -- and,
  // nothing being chosen, there is no Promote anywhere on screen.
  await selection.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const footer = page.getByTestId('quote-select-footer');
  await expect(footer).toBeInViewport();
  await expect(page.getByTestId('quote-select-cancel')).toBeInViewport();
  const footerBox = await boxOf(footer);
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(PHONE_VIEWPORT.height);
  expect(footerBox.y).toBeLessThan((await fieldGeometry(selection)).bottom);
  await expect(page.getByTestId(FAB)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Promote selection' })).toHaveCount(0);

  // The line whose top lies at least DEEP_OFFSET_PX below the field's first
  // line, brought to the middle of the screen in one scroll.
  const top = await fieldGeometry(selection);
  const lineIndex = Math.ceil(DEEP_OFFSET_PX / top.lineHeight);
  const deepLine = filler[lineIndex];
  if (deepLine === undefined) throw new Error('the entry is too short for a line that deep');
  const scroller = page.getByTestId('journal-page-scroll');
  await scroller.evaluate(
    (element, delta) => element.scrollBy(0, delta),
    top.firstLineTop + lineIndex * top.lineHeight - PHONE_VIEWPORT.height / HALF,
  );
  const line = await fieldGeometry(selection);
  const lineY = line.firstLineTop + lineIndex * line.lineHeight + line.lineHeight / HALF;
  expect(lineIndex * line.lineHeight).toBeGreaterThanOrEqual(DEEP_OFFSET_PX);
  expect(lineY).toBeGreaterThanOrEqual(line.lineHeight);
  expect(lineY).toBeLessThanOrEqual((await boxOf(footer)).y - line.lineHeight / HALF);

  await page.mouse.move(line.left + DRAG_INSET_PX, lineY);
  await page.mouse.down();
  await page.mouse.move(line.right - DRAG_INSET_PX, lineY, { steps: DRAG_STEPS });
  await page.mouse.up();
  const preview = page.getByTestId('quote-select-preview');
  await expect(preview).toContainText(`Line ${lineIndex + 1} `);
  const selectedText = (await preview.textContent())?.trim() ?? '';
  expect(deepLine.includes(selectedText)).toBe(true);

  // The pill has come to the reader: in view, centred over the text column,
  // floating its lift above the foot of the screen, and the only Promote there.
  const fab = page.getByTestId(FAB);
  await expect(fab).toBeInViewport();
  // Its fade and settle share one progress: full opacity means it has landed.
  await expect
    .poll(() =>
      page.getByTestId(`${FAB}-anchor`).evaluate((node) => getComputedStyle(node).opacity),
    )
    .toBe('1');
  await expect(page.getByRole('button', { name: 'Promote selection' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Clear selection' })).toBeInViewport();
  // The pill and its X, read as one centred group, against the text column
  // and the scroll viewport they float in.
  const pill = await boxOf(fab);
  const clear = await boxOf(page.getByTestId(`${FAB}-cancel`));
  const columnBox = await boxOf(selection);
  const viewport = await boxOf(scroller);
  const groupCentre = (pill.x + clear.x + clear.width) / HALF;
  expect(Math.abs(groupCentre - (columnBox.x + columnBox.width / HALF))).toBeLessThanOrEqual(
    EPSILON_PX,
  );
  const groupBottom = Math.max(pill.y + pill.height, clear.y + clear.height);
  expect(
    Math.abs(viewport.y + viewport.height - groupBottom - FLOATING_LIFT_PX),
  ).toBeLessThanOrEqual(EPSILON_PX);
  expect(groupBottom).toBeLessThanOrEqual((await boxOf(footer)).y);
  const column = await fieldGeometry(selection);
  expect(column.top).toBeLessThan(0);

  const promoteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/journal/${entryId}/promote`,
  );
  // A pointer press at the pill's place on screen, not a locator click that
  // would scroll its target into view first: no scroll stands between the
  // selection and its promotion.
  const [promoted] = await Promise.all([
    promoteResponse,
    page.mouse.click(pill.x + pill.width / HALF, pill.y + pill.height / HALF),
  ]);
  expect(promoted.ok()).toBe(true);
  await expect(page.getByTestId('quote-promotion-success')).toHaveText(PROMOTED_COPY);
  await expect(page.getByTestId(FAB)).toHaveCount(0);
  const promotions = await page.request.get(`${backendUrl()}/journal/${entryId}/promotions`, {
    headers,
  });
  expect(promotions.ok()).toBe(true);
  const quotes = (await promotions.json()) as Array<{ anchor_text: string }>;
  expect(quotes).toHaveLength(1);
  expect(quotes[0]?.anchor_text).toBe(selectedText);
});
