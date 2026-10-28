import { expect, test, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

/** WCAG / Candle & Ink touch floor (``touchTarget.minimum``), in CSS px. */
const TOUCH_TARGET_MIN = 44;
const EDIT_NAME = 'Edit this entry';
const LAPTOP = { width: 1280, height: 800 } as const;
const PHONE = { width: 390, height: 844 } as const;

/** 200% browser zoom on a phone: half the CSS viewport at twice the device pixels. */
const ZOOM_200 = 2;
const EDITED_LINE = ' A second look, and one more line.';
/** Browser rounding allowance for a glyph touching its containing edge. */
const EDGE_TOLERANCE = 0.5;

interface ReadActionSweep {
  buttonIds: string[];
  promoteLabelRectCount: number;
  promoteInsideSheet: boolean;
  promoteLabelInsideSheet: boolean;
  splitPromoteWords: string[];
  sidewaysOverflow: boolean;
}

/**
 * Read every finished-page action in one settled frame. The promote label is
 * measured as glyph rectangles rather than inferred from CSS: this catches the
 * last letter painting through the paper edge even when the button's own box
 * claims to fit. Per-word ranges also distinguish a useful two-line label from
 * a word the browser split in the middle (#3457).
 */
async function sweepReadActions(page: Page): Promise<ReadActionSweep> {
  return page.evaluate((slack) => {
    const sheet = document.querySelector('[data-testid="journal-sheet"]');
    const promote = document.querySelector('[data-testid="promote-quote-button"]');
    if (!(sheet instanceof HTMLElement) || !(promote instanceof HTMLElement)) {
      throw new Error('finished-page promote action is missing');
    }
    const sheetBox = sheet.getBoundingClientRect();
    const promoteBox = promote.getBoundingClientRect();
    const isInside = (inner: DOMRect, outer: DOMRect): boolean =>
      inner.left >= outer.left - slack &&
      inner.right <= outer.right + slack &&
      inner.top >= outer.top - slack &&
      inner.bottom <= outer.bottom + slack;
    const textNode = Array.from(promote.querySelectorAll('*'))
      .flatMap((element) => Array.from(element.childNodes))
      .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('Promote'));
    if (!textNode) throw new Error('Promote a quote label is missing');

    const labelRange = document.createRange();
    labelRange.selectNodeContents(textNode);
    const labelRects = Array.from(labelRange.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    const splitPromoteWords: string[] = [];
    for (const match of (textNode.textContent ?? '').matchAll(/\S+/gu)) {
      const word = document.createRange();
      word.setStart(textNode, match.index);
      word.setEnd(textNode, match.index + match[0].length);
      const tops = Array.from(word.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => rect.top);
      if (tops.length > 1 && Math.max(...tops) - Math.min(...tops) > slack) {
        splitPromoteWords.push(match[0]);
      }
    }

    const visibleButtons = Array.from(
      document.querySelectorAll<HTMLElement>('[role="button"][data-testid]'),
    ).filter((button) => {
      const box = button.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    return {
      buttonIds: visibleButtons.map((button) => button.dataset.testid ?? '').filter(Boolean),
      promoteLabelRectCount: labelRects.length,
      promoteInsideSheet: isInside(promoteBox, sheetBox),
      promoteLabelInsideSheet: labelRects.every((rect) => isInside(rect, sheetBox)),
      splitPromoteWords,
      sidewaysOverflow: document.documentElement.scrollWidth > innerWidth + slack,
    };
  }, EDGE_TOLERANCE);
}

/**
 * #3447: a finished entry reopened with the pencil must offer Finish again.
 * Finish sits centred under the body exactly as on a draft; pressing it sends
 * the edited body with ``finished`` in one PATCH and the page returns to reading
 * with the pencil back. The edit's autosave never demotes the entry to a draft.
 */
for (const [label, viewport, zoom] of [
  ['390', PHONE, 1],
  ['1280', LAPTOP, 1],
  ['390-zoom200', PHONE, ZOOM_200],
] as const) {
  test(`a finished entry reopened for editing can be finished again at ${label}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width / zoom, height: viewport.height / zoom },
      deviceScaleFactor: zoom,
    });
    const page = await context.newPage();
    try {
      await signUp(page, `journal-refinish-${label}`);
      await page.getByTestId('journal-new-entry').click();
      const body = page.getByTestId('journal-body-input');
      await body.fill('A page I closed once.');
      const finish = page.getByRole('button', { name: 'Mark this entry finished' });
      await finish.click();
      await expect(page.getByTestId('journal-body-read')).toBeVisible();

      const demotions: string[] = [];
      page.on('request', (request) => {
        if (request.method() !== 'PATCH' || !/\/journal\/\d+$/u.test(request.url())) return;
        const patch = request.postDataJSON() as { status?: string } | null;
        if (patch?.status === 'draft') demotions.push(request.url());
      });
      await page
        .getByTestId('journal-entry-exit-row')
        .getByRole('button', { name: EDIT_NAME })
        .click();
      await page.getByTestId('edit-confirm-edit').click();
      await expect(body).toBeVisible();
      // Control+End: the end of the whole text, not of a wrapped visual line.
      await body.press('Control+End');
      await body.pressSequentially(EDITED_LINE);
      await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
      await page.screenshot({ path: test.info().outputPath(`refinish-editing-${label}.png`) });
      await expect(finish).toBeVisible();
      // Scrolled to the top of the page, Finish is the element a tap there lands
      // on: the page's timer clearance (#3131) lifts it clear of the writing
      // timer, even at 200% zoom on a phone where the timer fills the lower half.
      await finish.evaluate((element) => element.scrollIntoView({ block: 'start' }));
      const reachable = await finish.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit !== null && element.contains(hit);
      });
      expect(reachable).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`refinish-finish-${label}.png`) });
      const box = await finish.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
      expect(demotions).toEqual([]);

      const finished = page.waitForRequest(
        (request) =>
          request.method() === 'PATCH' &&
          /\/journal\/\d+$/u.test(request.url()) &&
          (request.postDataJSON() as { status?: string } | null)?.status === 'finished',
      );
      await finish.click();
      const patch = (await finished).postDataJSON() as { message: string; status: string };
      expect(patch.message).toBe(`A page I closed once.${EDITED_LINE}`);
      await expect(page.getByTestId('journal-body-read')).toBeVisible();
      await expect(
        page.getByTestId('journal-entry-exit-row').getByRole('button', { name: EDIT_NAME }),
      ).toBeVisible();
      await expect(page.getByTestId('journal-body-input')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`refinish-read-${label}.png`) });
      const readActions = await sweepReadActions(page);
      expect(readActions.buttonIds).toEqual(
        expect.arrayContaining([
          'journal-api-key-settings',
          'journal-edit-button',
          'journal-close-entry',
          'promote-quote-button',
          'get-resonance-button',
        ]),
      );
      expect(readActions.promoteLabelRectCount).toBeGreaterThan(0);
      expect(readActions.promoteInsideSheet).toBe(true);
      expect(readActions.promoteLabelInsideSheet).toBe(true);
      expect(readActions.splitPromoteWords).toEqual([]);
      expect(readActions.sidewaysOverflow).toBe(false);
    } finally {
      await context.close();
    }
  });
}
