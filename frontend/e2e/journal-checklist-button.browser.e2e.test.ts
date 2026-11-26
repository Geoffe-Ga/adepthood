import { expect, test, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * The List button: one control for three kinds. Each press steps the caret's
 * line from prose to a bullet, a number, a checkbox, and back to prose; its
 * label and pressed state say where the line is. Three presses on a blank line
 * are the way into "checkbox mode", where Return keeps the checklist going
 * until an empty box ends it. Cmd/Ctrl+Shift+7, 8 and 9 name a kind directly,
 * a checked task is cleared whole when it leaves the cycle, and an item's
 * Shift+Return continuation line goes with it, re-indented under each new
 * marker. All in the real <textarea>, through the autosave and read routes,
 * into read mode after a cold reload.
 */

const LABELS = {
  none: 'List: none. Press for bulleted.',
  bullet: 'List: bulleted. Press for numbered.',
  ordered: 'List: numbered. Press for checkbox.',
  task: 'List: checkbox. Press for plain text.',
} as const;

/** The List button reads as the line's kind: its label, and pressed on any list kind. */
async function expectList(page: Page, kind: keyof typeof LABELS): Promise<void> {
  const button = page.getByTestId('journal-format-list');
  await expect(button).toHaveAttribute('aria-label', LABELS[kind]);
  await expect(button).toHaveAttribute('aria-pressed', String(kind !== 'none'));
}

async function pressList(page: Page): Promise<void> {
  await page.getByTestId('journal-format-list').click();
}

test('List cycles a line through bullet, number and checkbox, and Return keeps a checklist going', async ({
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

  // The three buttons this one replaced are gone.
  for (const gone of ['bullet', 'ordered', 'task']) {
    await expect(page.getByTestId(`journal-format-${gone}`)).toHaveCount(0);
  }

  // On a blank line the button is released; each press is one step of the cycle.
  await field.click();
  await expectList(page, 'none');
  await pressList(page);
  await expect(field).toHaveValue('- ');
  await expectList(page, 'bullet');
  await pressList(page);
  await expect(field).toHaveValue('1. ');
  await expectList(page, 'ordered');
  await pressList(page);
  await expect(field).toHaveValue('- [ ] ');
  await expect(field).toBeFocused();
  await expectList(page, 'task');
  await expect(page.getByRole('button', { name: 'Indent list item' })).toBeEnabled();

  // Type, Return: a new unchecked box. Return on the empty box: out of the list.
  await page.keyboard.type('buy oats');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('- [ ] buy oats\n- [ ] ');
  await expectList(page, 'task');
  await page.keyboard.type('buy milk');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('- [ ] buy oats\n- [ ] buy milk\n- [ ] ');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('- [ ] buy oats\n- [ ] buy milk\n');
  await expectList(page, 'none');

  // The keyboard names a kind directly: a numbered item becomes a task in place.
  await page.keyboard.type('2. call Sam');
  await expectList(page, 'ordered');
  await page.keyboard.press('ControlOrMeta+Shift+Digit9');
  await expect(field).toHaveValue('- [ ] buy oats\n- [ ] buy milk\n- [ ] call Sam');
  await expectList(page, 'task');

  // A checked task leaves the cycle whole: the box goes, its words stay.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- [x] rest');
  await expectList(page, 'task');
  await pressList(page);
  const head = '- [ ] buy oats\n- [ ] buy milk\n- [ ] call Sam\n';
  await expect(field).toHaveValue(`${head}rest`);
  await expectList(page, 'none');

  // Cmd/Ctrl+Shift+7 numbers the line and +8 bullets it, without cycling.
  await page.keyboard.press('ControlOrMeta+Shift+Digit7');
  await expect(field).toHaveValue(`${head}1. rest`);
  await expectList(page, 'ordered');
  await page.keyboard.press('ControlOrMeta+Shift+Digit8');
  await expect(field).toHaveValue(`${head}- rest`);
  await expectList(page, 'bullet');

  // A continuation line belongs to its item: it follows it through the cycle,
  // re-indented under each new marker, also when the caret is on that line.
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('a while');
  await expect(field).toHaveValue(`${head}- rest\n  a while`);
  await expectList(page, 'bullet');
  await pressList(page);
  await expect(field).toHaveValue(`${head}1. rest\n   a while`);
  await expectList(page, 'ordered');
  await pressList(page);
  const message = `${head}- [ ] rest\n      a while`;
  await expect(field).toHaveValue(message);
  await expectList(page, 'task');

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
