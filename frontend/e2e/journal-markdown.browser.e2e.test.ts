import { expect, test } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

test('journal Markdown renders after finish and a cold reload while its source stays unchanged', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-markdown');
  const token = await tokenFor(page.request, email);
  const body =
    '*Bold truth* beside _quiet emphasis_.\n> First remembered line\n> _Second remembered line_';
  await page.getByTestId('journal-new-entry').click();
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill('Formatted page');
  await page.getByTestId('journal-body-input').fill(body);
  const [created] = await Promise.all([
    createResponse,
    page.getByTestId('journal-finish-button').click(),
  ]);
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;

  const readBody = page.getByTestId('journal-body-read');
  await expect(readBody).not.toHaveAttribute('tabindex', '0');
  expect(await readBody.evaluate((element) => getComputedStyle(element).cursor)).not.toBe(
    'pointer',
  );
  await expect(readBody.locator('strong')).toHaveText('Bold truth');
  await expect(readBody.locator('em')).toHaveText(['quiet emphasis', 'Second remembered line']);
  await expect(readBody.locator('blockquote')).toHaveText(
    'First remembered line\nSecond remembered line',
  );
  await expect(readBody).not.toContainText('*Bold truth*');
  await expect(readBody).not.toContainText('> First remembered line');

  const stored = await page.request.get(`${backendUrl()}/journal/${entryId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(stored.ok()).toBe(true);
  expect((await stored.json()) as { message: string }).toEqual(
    expect.objectContaining({ message: body }),
  );

  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  const reloadedBody = page.getByTestId('journal-body-read');
  await expect(reloadedBody.locator('strong')).toHaveText('Bold truth');
  await expect(reloadedBody.locator('em')).toHaveCount(2);
  await expect(reloadedBody.locator('blockquote')).toContainText('Second remembered line');
});

test('journal headings, numbered items, tasks and rules render after a cold reload while the source stays unchanged (#3251)', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-markdown-blocks');
  const token = await tokenFor(page.request, email);
  const body =
    '## Tuesday\n1. walked\n10) wrote\n- [x] called Sam\n- [ ] book the room\n---\nafter the rule';
  await page.getByTestId('journal-new-entry').click();
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill('Structured page');
  await page.getByTestId('journal-body-input').fill(body);
  const [created] = await Promise.all([
    createResponse,
    page.getByTestId('journal-finish-button').click(),
  ]);
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;

  const expectBlocks = async (): Promise<void> => {
    const read = page.getByTestId('journal-body-read');
    await expect(read.locator('h2')).toHaveText('Tuesday');
    await expect(read.locator('[data-testid^="journal-markdown-ordinal-"]')).toHaveText([
      '\u20071. ',
      '10) ',
    ]);
    await expect(read.locator('[data-testid^="journal-markdown-checkbox-"]')).toHaveText([
      '\u2611 ',
      '\u2610 ',
    ]);
    await expect(read.getByTestId('journal-markdown-task-done-31')).toHaveText('called Sam');
    await expect(read.locator('[data-testid^="journal-markdown-rule-"]')).toHaveCount(1);
    await expect(read).toContainText('after the rule');
    for (const raw of ['## ', '[x]', '[ ]', '---']) {
      await expect(read).not.toContainText(raw);
    }
  };
  await expectBlocks();

  const stored = await page.request.get(`${backendUrl()}/journal/${entryId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(stored.ok()).toBe(true);
  expect((await stored.json()) as { message: string }).toEqual(
    expect.objectContaining({ message: body }),
  );

  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await expectBlocks();
});
