import { expect, test, type Locator } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * List nesting from the keyboard: Tab / Shift+Tab / Return / Backspace in the
 * real <textarea>, the autosave and read routes, and read mode's nested bullets
 * after a cold reload. The stored message is exactly the indentation typed.
 */

async function caretToEnd(field: Locator): Promise<void> {
  await field.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  });
}

test('Tab, Shift+Tab, Return and Backspace nest a list and the nesting survives a reload', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-list-indent');
  const token = await tokenFor(page.request, email);
  await page.getByTestId('journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill('Nested list');
  const field = page.getByTestId('journal-body-input');

  // Tab on a prose line is not the editor's: focus moves on and nothing changes.
  await field.click();
  await page.keyboard.type('Intro');
  await page.keyboard.press('Tab');
  await expect(field).not.toBeFocused();
  await expect(field).toHaveValue('Intro');

  await caretToEnd(field);
  await page.keyboard.press('Enter');
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Intro\n- one\n  - ');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('three');
  await expect(field).toHaveValue('Intro\n- one\n  - two\n    - three');

  // Return on an empty nested item steps out one level.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('Intro\n- one\n  - two\n    - three\n  - ');
  await page.keyboard.type('back');

  // Backspace at an empty nested item's content start steps out one level too.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  await expect(field).toHaveValue('Intro\n- one\n  - two\n    - three\n  - back\n- ');
  await page.keyboard.type('flat');
  const message = 'Intro\n- one\n  - two\n    - three\n  - back\n- flat';
  await expect(field).toHaveValue(message);

  // Shift+Tab at level 0 changes nothing and hands focus back: never a trap.
  await page.keyboard.press('Shift+Tab');
  await expect(field).not.toBeFocused();
  await expect(field).toHaveValue(message);

  // Indent and outdent from the toolbar on a nested line.
  await field.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    const at = area.value.indexOf('two');
    area.focus();
    area.setSelectionRange(at, at);
  });
  await page.getByRole('button', { name: 'Outdent list item' }).click();
  await expect(field).toHaveValue(message.replace('  - two', '- two'));
  await page.getByRole('button', { name: 'Indent list item' }).click();
  await expect(field).toHaveValue(message);

  const entryId = ((await (await created).json()) as { id: number }).id;
  await page.getByTestId('journal-finish-button').click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
  await expect
    .poll(async () => {
      const stored = await page.request.get(`${backendUrl()}/journal/${entryId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return ((await stored.json()) as { message: string }).message;
    })
    .toBe(message);

  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  const list = page.getByTestId('journal-markdown-bullet-6');
  // Read verbatim: a normalising text matcher would collapse the indent under test.
  expect(await list.evaluate((element) => element.textContent)).toBe(
    '• one\n  • two\n    • three\n  • back\n• flat',
  );
});
