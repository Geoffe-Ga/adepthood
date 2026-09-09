import { expect, test } from '@playwright/test';

import {
  askForResonance,
  backendUrl,
  seedHabit,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

test('a failed short-entry reflection still offers and checks off a completed habit', async ({
  page,
}) => {
  const email = await signUp(page, 'short-entry-habit-offer');
  const token = await tokenFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  await seedHabit(page.request, token, 'Morning walk');
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: 'A small note', message: 'I completed Morning walk.' },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${entryId}`, {
    headers,
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);

  // Reproduce the production failure boundary deterministically: only the
  // literary pass is refused. The follow-up completion check, suggestion row,
  // acceptance, and habit check-in all continue over the real wire.
  await page.route(`**/journal/${entryId}/resonance`, async (route) => {
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'llm_provider_error' }),
    });
  });
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await askForResonance(page);

  await expect(page.getByTestId('journal-resonance-error')).toContainText(
    "We couldn't create a reflection for this entry.",
  );
  await expect(page.getByTestId('journal-resonance-error')).toContainText(
    'We still checked it for completed habits',
  );
  await page.getByRole('button', { name: 'Check off completed Morning walk', exact: true }).click();
  await expect(page.getByText(/Checked off/u)).toBeVisible();

  const suggestions = await page.request.get(`${backendUrl()}/journal/${entryId}/suggestions`, {
    headers,
  });
  expect(suggestions.ok()).toBe(true);
  expect((await suggestions.json()) as { items: Array<{ status: string }> }).toEqual({
    items: [expect.objectContaining({ status: 'accepted' })],
  });
});
