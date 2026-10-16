import { expect, test } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

/** WCAG / Candle & Ink touch floor (``touchTarget.minimum``), in CSS px. */
const TOUCH_TARGET_MIN = 44;
const EDIT_NAME = 'Edit this entry';
const LAPTOP = { width: 1280, height: 720 } as const;
const PHONE = { width: 390, height: 844 } as const;

/** 200% browser zoom on a phone: half the CSS viewport at twice the device pixels. */
const ZOOM_200 = 2;
const EDITED_LINE = ' A second look, and one more line.';

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
    } finally {
      await context.close();
    }
  });
}
