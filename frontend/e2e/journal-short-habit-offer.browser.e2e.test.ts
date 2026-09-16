import { expect, test } from '@playwright/test';

import {
  askForResonance,
  backendUrl,
  isoDaysAgo,
  seedHabit,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/** The one suggestion this entry produces, read back off the real wire. */
interface SuggestionRow {
  id: number;
  status: string;
  completed_units: number | null;
  completed_on: string | null;
}

test('a failed short-entry reflection still offers and checks off a completed habit', async ({
  page,
}) => {
  const email = await signUp(page, 'short-entry-habit-offer');
  const token = await tokenFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  const habitId = await seedHabit(page.request, token, 'Morning walk');
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    // States an amount and a day, so detection has facts to extract and the
    // offer card has something to promise. "3 times" against the default goal
    // unit "units" is deliberate: both words live in the same canonical unit
    // group (backend/src/domain/detection_facts.py), which is the path that
    // keeps this feature alive for every habit in the default configuration.
    data: { title: 'A small note', message: 'I completed Morning walk 3 times yesterday.' },
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
  // Read just before the pass so the day the server resolves "yesterday"
  // against is the same one this expectation is built from.
  const yesterday = isoDaysAgo(1);
  await askForResonance(page);

  await expect(page.getByTestId('journal-resonance-error')).toContainText(
    "We couldn't create a reflection for this entry.",
  );
  await expect(page.getByTestId('journal-resonance-error')).toContainText(
    'We still checked it for completed habits',
  );

  const offered = await page.request.get(`${backendUrl()}/journal/${entryId}/suggestions`, {
    headers,
  });
  expect(offered.ok()).toBe(true);
  const [pending] = ((await offered.json()) as { items: SuggestionRow[] }).items;
  expect(pending).toMatchObject({
    status: 'pending',
    completed_units: 3,
    completed_on: yesterday,
  });

  // The card states what OK will log before the writer consents to it, and
  // names it again in the button a screen reader reads out.
  await expect(page.getByTestId(`suggestion-${pending!.id}`)).toContainText(
    '· 3 units · yesterday. Log it?',
  );
  await page
    .getByRole('button', {
      name: 'Check off completed Morning walk, 3 units, yesterday',
      exact: true,
    })
    .click();
  await expect(page.getByText(/Checked off/u)).toBeVisible();

  const suggestions = await page.request.get(`${backendUrl()}/journal/${entryId}/suggestions`, {
    headers,
  });
  expect(suggestions.ok()).toBe(true);
  expect((await suggestions.json()) as { items: SuggestionRow[] }).toEqual({
    items: [
      expect.objectContaining({
        status: 'accepted',
        completed_units: 3,
        completed_on: yesterday,
      }),
    ],
  });

  // What the card promised is what the accept persisted: the stated amount, on
  // the stated day, rather than the goal's target on today.
  const habit = await page.request.get(`${backendUrl()}/habits/${habitId}`, { headers });
  expect(habit.ok()).toBe(true);
  const goals = (
    (await habit.json()) as {
      goals: Array<{ completions: Array<{ local_day: string; completed_units: number }> }>;
    }
  ).goals;
  const logged = goals.flatMap((goal) => goal.completions);
  expect(logged).toEqual([expect.objectContaining({ local_day: yesterday, completed_units: 3 })]);
});
