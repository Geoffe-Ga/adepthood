import { expect, test, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * The Checklist button: one press turns the caret's line into an unchecked
 * task, and from there Return keeps the checklist going until an empty box
 * ends it -- the button is the way into "checkbox mode". It converts a bullet
 * or a numbered item in place, clears a task (checked or not) back to prose,
 * and is never pressed together with Bulleted list. All in the real
 * <textarea>, through the autosave and read routes, into read mode after a
 * cold reload.
 */

async function press(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name, exact: true });
  await button.scrollIntoViewIfNeeded();
  await button.click();
}

async function expectPressed(page: Page, pressed: Record<string, boolean>): Promise<void> {
  for (const [command, on] of Object.entries(pressed)) {
    await expect(page.getByTestId(`journal-format-${command}`)).toHaveAttribute(
      'aria-pressed',
      String(on),
    );
  }
}

test('Checklist starts a task list that Return continues and an empty box ends', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const email = await signUp(page, 'journal-checklist-button');
  const token = await tokenFor(page.request, email);
  await page.getByTestId('journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill('Checklist');
  const field = page.getByTestId('journal-body-input');

  // On a blank line the button is released; one press starts an unchecked box.
  await field.click();
  await expectPressed(page, { task: false, bullet: false });
  await press(page, 'Checklist');
  await expect(field).toHaveValue('- [ ] ');
  await expect(field).toBeFocused();
  await expectPressed(page, { task: true, bullet: false, ordered: false });
  await expect(page.getByRole('button', { name: 'Indent list item' })).toBeEnabled();

  // Type, Return: a new unchecked box. Return on the empty box: out of the list.
  await page.keyboard.type('buy oats');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('- [ ] buy oats\n- [ ] ');
  await expectPressed(page, { task: true });
  await page.keyboard.type('buy milk');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('- [ ] buy oats\n- [ ] buy milk\n- [ ] ');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('- [ ] buy oats\n- [ ] buy milk\n');
  await expectPressed(page, { task: false });

  // A numbered item becomes a task in place, from the keyboard chord.
  await page.keyboard.type('2. call Sam');
  await expectPressed(page, { ordered: true, task: false });
  await page.keyboard.press('ControlOrMeta+Shift+Digit9');
  await expect(field).toHaveValue('- [ ] buy oats\n- [ ] buy milk\n- [ ] call Sam');
  await expectPressed(page, { ordered: false, task: true });

  // A checked task is cleared whole; its words stay.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- [x] rest');
  await expectPressed(page, { task: true, bullet: false });
  await press(page, 'Checklist');
  await expect(field).toHaveValue('- [ ] buy oats\n- [ ] buy milk\n- [ ] call Sam\nrest');
  await expectPressed(page, { task: false, bullet: false });

  // Bulleted list and Checklist trade places on the same line, never both pressed.
  await press(page, 'Bulleted list');
  await expect(field).toHaveValue('- [ ] buy oats\n- [ ] buy milk\n- [ ] call Sam\n- rest');
  await expectPressed(page, { task: false, bullet: true });
  await press(page, 'Checklist');
  const message = '- [ ] buy oats\n- [ ] buy milk\n- [ ] call Sam\n- [ ] rest';
  await expect(field).toHaveValue(message);
  await expectPressed(page, { task: true, bullet: false });

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
  await expect(page.locator('[data-testid^="journal-markdown-checkbox-"]')).toHaveCount(4);
});
