import { expect, test, type Locator } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Numbered and task lists from the keyboard: Return gives the next number (and
 * renumbers the items below when it lands mid-list) or the next unchecked box,
 * Tab / Shift+Tab nest a numbered item and renumber both runs, and Return on an
 * empty item leaves the list. All in the real <textarea>, through the autosave
 * and read routes, and into read mode after a cold reload.
 */

async function caretAfter(field: Locator, text: string): Promise<void> {
  await field.evaluate((element, needle) => {
    const area = element as HTMLTextAreaElement;
    const at = area.value.indexOf(needle) + needle.length;
    area.focus();
    area.setSelectionRange(at, at);
  }, text);
}

async function caret(field: Locator): Promise<number> {
  return field.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    return area.selectionStart === area.selectionEnd ? area.selectionStart : -1;
  });
}

test('Return numbers and renumbers a list, continues checkboxes and leaves an empty item', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-ordered-list-edit');
  const token = await tokenFor(page.request, email);
  await page.getByTestId('journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill('Numbered list');
  const field = page.getByTestId('journal-body-input');

  // The Numbered list button starts the list; Return keeps it going.
  await field.click();
  await page.getByRole('button', { name: 'Numbered list', exact: true }).click();
  await expect(field).toHaveValue('1. ');
  await page.keyboard.type('walked');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('1. walked\n2. ');
  await page.keyboard.type('wrote');
  await page.keyboard.press('Enter');
  await page.keyboard.type('slept');
  await expect(field).toHaveValue('1. walked\n2. wrote\n3. slept');

  // Return in the middle takes the next number and counts the rest on.
  await caretAfter(field, 'walked');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('1. walked\n2. \n3. wrote\n4. slept');
  expect(await caret(field)).toBe('1. walked\n2. '.length);
  await page.keyboard.type('ate');
  await expect(field).toHaveValue('1. walked\n2. ate\n3. wrote\n4. slept');

  // Tab nests the item from 1. and closes the gap it left; Shift+Tab undoes it.
  await page.keyboard.press('Tab');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('1. walked\n  1. ate\n2. wrote\n3. slept');
  expect(await caret(field)).toBe('1. walked\n  1. ate'.length);
  await page.keyboard.press('Shift+Tab');
  await expect(field).toHaveValue('1. walked\n2. ate\n3. wrote\n4. slept');
  await page.getByRole('button', { name: 'Indent list item' }).click();
  await expect(field).toHaveValue('1. walked\n  1. ate\n2. wrote\n3. slept');

  // Return on an empty numbered item leaves the list.
  await caretAfter(field, 'slept');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('1. walked\n  1. ate\n2. wrote\n3. slept\n4. ');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('1. walked\n  1. ate\n2. wrote\n3. slept\n');

  // A checkbox continues as an unchecked checkbox, and an empty one exits too.
  await page.keyboard.type('- [x] call Sam');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue(
    '1. walked\n  1. ate\n2. wrote\n3. slept\n- [x] call Sam\n- [ ] ',
  );
  await page.keyboard.type('write');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Done.');
  const message = '1. walked\n  1. ate\n2. wrote\n3. slept\n- [x] call Sam\n- [ ] write\nDone.';
  await expect(field).toHaveValue(message);
  expect(await caret(field)).toBe(message.length);

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
  const ordinals: [start: number, text: string][] = [
    [message.indexOf('1. walked'), '1.'],
    [message.indexOf('  1. ate'), '1.'],
    [message.indexOf('2. wrote'), '2.'],
    [message.indexOf('3. slept'), '3.'],
  ];
  for (const [start, text] of ordinals) {
    const ordinal = page.getByTestId(`journal-markdown-ordinal-${String(start)}`);
    expect((await ordinal.evaluate((element) => element.textContent)).trim()).toBe(text);
  }
  await expect(page.locator('[data-testid^="journal-markdown-checkbox-"]')).toHaveCount(2);
});
