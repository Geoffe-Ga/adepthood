import { expect, test } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

/** #3448: the reversible read-mode checkbox remains reachable at every review frame. */
for (const [label, viewport, scale] of [
  ['phone-390x844', PHONE, 1],
  ['phone-390x844-200-percent', PHONE, 2],
  ['desktop-1280x800', DESKTOP, 1],
] as const) {
  test(`a finished task toggles, persists and reloads at ${label}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width / scale, height: viewport.height / scale },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    try {
      await signUp(page, `finished-task-${label}`);
      await page.getByTestId('journal-new-entry').click();
      await page.getByTestId('journal-title-input').fill('Errands');
      await page.getByTestId('journal-body-input').fill('- [ ] milk\n  - [x] bread');
      await page.getByRole('button', { name: 'Mark this entry finished' }).click();

      const milk = page.getByRole('checkbox', { name: 'milk' });
      await expect(milk).toHaveAttribute('aria-checked', 'false');
      await milk.scrollIntoViewIfNeeded();
      const target = await milk.boundingBox();
      expect(target).not.toBeNull();
      expect(target!.width).toBeGreaterThanOrEqual(44);
      expect(target!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: test.info().outputPath(`${label}-before.png`) });
      const patchRequest = page.waitForRequest(
        (request) => request.method() === 'PATCH' && /\/journal\/\d+$/u.test(request.url()),
      );
      await milk.click({ position: { x: 2, y: target!.height / 2 } });
      const patch = (await patchRequest).postDataJSON() as {
        message?: string;
        status?: string;
      };
      expect(patch).toEqual({ message: '- [x] milk\n  - [x] bread' });
      await expect(milk).toHaveAttribute('aria-checked', 'true');

      const keyboardPatchRequest = page.waitForRequest(
        (request) => request.method() === 'PATCH' && /\/journal\/\d+$/u.test(request.url()),
      );
      await milk.focus();
      await page.keyboard.press('Space');
      expect((await keyboardPatchRequest).postDataJSON()).toEqual({
        message: '- [ ] milk\n  - [x] bread',
      });
      await expect(milk).toHaveAttribute('aria-checked', 'false');

      const enterPatchRequest = page.waitForRequest(
        (request) => request.method() === 'PATCH' && /\/journal\/\d+$/u.test(request.url()),
      );
      await page.keyboard.press('Enter');
      expect((await enterPatchRequest).postDataJSON()).toEqual({
        message: '- [x] milk\n  - [x] bread',
      });
      await expect(milk).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
      await page.screenshot({ path: test.info().outputPath(`${label}-after.png`) });

      await page.reload();
      const shelfRow = page.locator('[data-testid^="journal-shelf-open-"]').filter({
        hasText: 'Errands',
      });
      await shelfRow.click();
      await expect(page.getByRole('checkbox', { name: 'milk' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(page.getByRole('checkbox', { name: 'bread' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(page.getByTestId('journal-body-input')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`${label}-reloaded.png`) });
    } finally {
      await context.close();
    }
  });
}
