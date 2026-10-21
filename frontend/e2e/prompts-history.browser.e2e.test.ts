import { expect, test } from '@playwright/test';

import {
  signUp,
  openPrompts,
  tokenFor,
  backendUrl,
  setProgramAnchorDaysAgo,
} from './journalHabitsBrowserSupport';

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

test('unanswered past questions page alongside saved answers and open a plain entry', async ({
  page,
}) => {
  const email = await signUp(page, 'prompts-unanswered-history');
  const token = await tokenFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  // Week 24: 23 past weeks, enough to cross the inline history's 20-row page.
  setProgramAnchorDaysAgo(email, 23 * 7);
  const saved = await page.request.post(`${backendUrl()}/prompts/2/respond`, {
    headers,
    data: { response: 'One answered week among the skipped questions.' },
  });
  expect(saved.ok()).toBe(true);
  await page.reload();
  await openPrompts(page);
  await expect(page.getByTestId('journal-review-early-card')).toBeVisible();
  const past = page.getByTestId('journal-notification-section-past-prompts');
  await past.getByTestId('prompt-history-row-23').scrollIntoViewIfNeeded();
  await expect(past.getByTestId('prompt-history-response-23')).toHaveCount(0);
  await expect(past.getByTestId('prompt-history-row-24')).toHaveCount(0);
  await past.getByTestId('prompt-history-more').click();
  await expect(past.getByTestId('prompt-history-response-2')).toHaveText(
    'One answered week among the skipped questions.',
  );
  const write = past.getByTestId('prompt-history-write-1');
  await write.scrollIntoViewIfNeeded();
  await expect(past.getByTestId('prompt-history-response-1')).toHaveCount(0);
  await expect(past.getByTestId('prompt-history-more')).toHaveCount(0);
  await write.click();
  await expect(page.getByTestId('journal-body-input')).toBeVisible();
  await page.getByTestId('journal-body-input').fill('An unwritten question still has room for me.');
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
  const history = await page.request.get(`${backendUrl()}/prompts/history`, { headers });
  expect((await history.json()).items).toEqual([
    expect.objectContaining({
      week_number: 2,
      response: 'One answered week among the skipped questions.',
    }),
  ]);
});
