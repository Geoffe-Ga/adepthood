import { expect, test, type Page, type Route } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

/** The active copy when React Navigation keeps a prior screen mounted underneath. */
function visible(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`);
}

async function writeFinishedTask(page: Page, title: string): Promise<void> {
  await visible(page, 'journal-new-entry').click();
  await visible(page, 'journal-title-input').fill(title);
  await visible(page, 'journal-body-input').fill('- [ ] milk');
  await page.getByRole('button', { name: 'Mark this entry finished' }).click();
  await expect(page.getByRole('checkbox', { name: 'milk' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
}

function isTaskPatch(route: Route): boolean {
  const request = route.request();
  if (request.method() !== 'PATCH' || !/\/journal\/\d+$/u.test(request.url())) return false;
  return (request.postDataJSON() as { message?: string }).message === '- [x] milk';
}

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

  test(`task saves preserve editing and block Close until durable at ${label}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width / scale, height: viewport.height / scale },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    try {
      await signUp(page, `finished-task-feedback-${label}`);
      await writeFinishedTask(page, 'Race-safe task');

      let releaseTask!: () => void;
      const taskReleased = new Promise<void>((resolve) => {
        releaseTask = resolve;
      });
      let taskStarted!: () => void;
      const taskStart = new Promise<void>((resolve) => {
        taskStarted = resolve;
      });
      let delayed = false;
      await page.route('**/journal/*', async (route) => {
        if (!delayed && isTaskPatch(route)) {
          delayed = true;
          taskStarted();
          await taskReleased;
        }
        await route.continue();
      });

      await page.getByRole('checkbox', { name: 'milk' }).click();
      await taskStart;
      await page.getByTestId('journal-edit-button').click();
      await page.getByTestId('edit-confirm-edit').click();
      const editor = visible(page, 'journal-body-input');
      await editor.fill('- [x] milk\nA newer thought survives.');
      const editorSave = page.waitForRequest((request) => {
        if (request.method() !== 'PATCH' || !/\/journal\/\d+$/u.test(request.url())) return false;
        return (
          (request.postDataJSON() as { message?: string }).message ===
          '- [x] milk\nA newer thought survives.'
        );
      });
      releaseTask();
      await expect(editor).toHaveValue('- [x] milk\nA newer thought survives.');
      await editorSave;
      await expect(editor).toHaveValue('- [x] milk\nA newer thought survives.');
      await expect(visible(page, 'journal-save-hint')).toHaveText('Saved');
      await page.screenshot({ path: test.info().outputPath(`${label}-edit-race-preserved.png`) });

      await page.unroute('**/journal/*');
      let releaseCloseSave!: () => void;
      const closeSaveReleased = new Promise<void>((resolve) => {
        releaseCloseSave = resolve;
      });
      let closeSaveStarted!: () => void;
      const closeSaveStart = new Promise<void>((resolve) => {
        closeSaveStarted = resolve;
      });
      await page.route('**/journal/*', async (route) => {
        const request = route.request();
        const message = (request.postDataJSON() as { message?: string } | null)?.message;
        if (request.method() === 'PATCH' && message?.endsWith('The body when X was pressed.')) {
          closeSaveStarted();
          await closeSaveReleased;
        }
        await route.continue();
      });
      await editor.fill('- [x] milk\nThe body when X was pressed.');
      await closeSaveStart;
      await visible(page, 'journal-close-entry').click();
      await editor.fill('- [x] milk\nNewer text typed after X survives.');
      const newestCloseSave = page.waitForRequest((request) => {
        if (request.method() !== 'PATCH' || !/\/journal\/\d+$/u.test(request.url())) return false;
        return (
          (request.postDataJSON() as { message?: string }).message ===
          '- [x] milk\nNewer text typed after X survives.'
        );
      });
      releaseCloseSave();
      await newestCloseSave;
      await expect(
        page.locator('[data-testid^="journal-shelf-open-"]:visible').filter({
          hasText: 'Race-safe task',
        }),
      ).toBeVisible();
      await page
        .locator('[data-testid^="journal-shelf-open-"]:visible')
        .filter({ hasText: 'Race-safe task' })
        .click();
      await expect(visible(page, 'journal-body-read')).toContainText(
        'Newer text typed after X survives.',
      );
      await page.screenshot({ path: test.info().outputPath(`${label}-post-close-typing.png`) });

      await page.unroute('**/journal/*');
      await visible(page, 'journal-close-entry').click();
      await expect(
        page.locator('[data-testid^="journal-shelf-open-"]:visible').filter({
          hasText: 'Race-safe task',
        }),
      ).toBeVisible();
      await writeFinishedTask(page, 'Durable Close');

      let attempts = 0;
      await page.route('**/journal/*', async (route) => {
        if (!isTaskPatch(route)) return route.continue();
        attempts += 1;
        if (attempts <= 2) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'offline test refusal' }),
          });
        } else {
          await route.continue();
        }
      });

      const milk = page.getByRole('checkbox', { name: 'milk' });
      await milk.click();
      await expect(visible(page, 'journal-save-retry')).toBeVisible();
      await visible(page, 'journal-close-entry').click();
      await expect.poll(() => attempts).toBe(2);
      await expect(visible(page, 'journal-body-read')).toBeVisible();
      await expect(visible(page, 'journal-save-retry')).toBeVisible();
      await expect(milk).toHaveAttribute('aria-checked', 'false');
      await page.screenshot({ path: test.info().outputPath(`${label}-close-blocked.png`) });

      await visible(page, 'journal-save-retry').click();
      await expect.poll(() => attempts).toBe(3);
      await expect(milk).toHaveAttribute('aria-checked', 'true');
      await expect(visible(page, 'journal-save-hint')).toHaveText('Saved');
      await visible(page, 'journal-close-entry').click();
      await expect(visible(page, 'journal-new-entry')).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`${label}-close-after-save.png`) });
    } finally {
      await context.close();
    }
  });
}
