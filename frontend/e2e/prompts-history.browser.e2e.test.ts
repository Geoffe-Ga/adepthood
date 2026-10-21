import { expect, test } from '@playwright/test';

import { signUp, openPrompts, tokenFor, backendUrl } from './journalHabitsBrowserSupport';

test('past prompt cards stay below current invitations and start a new plain entry', async ({
  page,
}) => {
  const email = await signUp(page, 'prompts-history');
  const token = await tokenFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  const answered = await page.request.post(`${backendUrl()}/prompts/1/respond`, {
    headers,
    data: { response: 'An earlier answer to keep.' },
  });
  expect(answered.ok()).toBe(true);
  await openPrompts(page);
  const past = page.getByTestId('journal-notification-section-past-prompts');
  await past.scrollIntoViewIfNeeded();
  await expect(past.getByTestId('prompt-history-response-1')).toHaveText(
    'An earlier answer to keep.',
  );
  await past.getByTestId('prompt-history-write-1').click();
  await expect(page.getByTestId('journal-body-input')).toBeVisible();
  await page.getByTestId('journal-body-input').fill('A new thought from the same question.');
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
  const history = await page.request.get(`${backendUrl()}/prompts/history`, { headers });
  expect((await history.json()).items).toEqual([
    expect.objectContaining({ response: 'An earlier answer to keep.' }),
  ]);
});
