import { expect, test } from '@playwright/test';

import {
  askForResonance,
  backendUrl,
  dayKeyIn,
  seedHabit,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';

/** The one suggestion this entry produces, read back off the real wire. */
interface SuggestionRow {
  id: number;
  status: string;
  completed_units: number | null;
  completed_on: string | null;
  logged_on: string | null;
}

/**
 * The day before `dayKey`, as `YYYY-MM-DD`.
 *
 * Calendar math through `Date.UTC`, not `now - 86_400_000`: subtracting a
 * fixed 24 hours lands on the same local day across a fall-back transition and
 * skips one across a spring-forward, and this expectation is compared against a
 * server that did real calendar arithmetic.
 */
function previousDay(dayKey: string): string {
  return shiftDay(dayKey, -1);
}

/** `dayKey` moved `days` calendar days, as `YYYY-MM-DD` (see `previousDay`). */
function shiftDay(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`not a YYYY-MM-DD day key: ${dayKey}`);
  }
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * How the settled card writes a day that is neither today nor yesterday:
 * `"Mon, Sep 7"`. Spelled out rather than imported from the app, so a change
 * to the card's format is a visible change to this expectation.
 */
function writtenDay(dayKey: string): string {
  return new Date(`${dayKey}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

test('a failed short-entry reflection still offers and checks off a completed habit', async ({
  page,
}) => {
  const email = await signUp(page, 'short-entry-habit-offer');
  const { token, timezone } = await sessionFor(page.request, email);
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
  const entry = (await created.json()) as { id: number; timestamp: string };
  const entryId = entry.id;
  // Derived exactly as the server derives it, and from the same anchor:
  // `_detection_inputs` builds `DetectionClock.entry_day` as
  // `to_user_date_bucket(entry.timestamp, user_tz)`, and `resolve_when` reads
  // "yesterday" as the day before THAT -- never the day before now, and never
  // a UTC day. Computing it here in UTC instead made these assertions fail for
  // part of every day on any host east or west of it, against a server that
  // had behaved correctly.
  const entryDay = dayKeyIn(entry.timestamp, timezone);
  const yesterday = previousDay(entryDay);
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
  if (pending === undefined) throw new Error('detection offered no suggestion to consent to');
  await expect(page.getByTestId(`suggestion-${pending.id}`)).toContainText(
    '· 3 units · yesterday. Log it?',
  );
  await page
    .getByRole('button', {
      name: 'Check off completed Morning walk, 3 units, yesterday',
      exact: true,
    })
    .click();
  // Settled, the card names the day the server recorded as logged (#2905).
  await expect(page.getByTestId(`suggestion-${pending.id}-checked`)).toContainText(
    'Checked off · 3 units · yesterday',
  );

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
        logged_on: yesterday,
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

  // Reopened the next day, the card is hydrated from the suggestion list alone
  // -- no check-in in hand -- and still names the day the completion was
  // logged on: two days back now, so written as a date (#2905).
  const nextDay = shiftDay(entryDay, 1);
  const nextMidday = new Date(`${nextDay}T12:00:00Z`);
  expect(dayKeyIn(nextMidday.toISOString(), timezone), 'midday UTC is not that day here').toBe(
    nextDay,
  );
  await page.getByTestId('journal-close-entry').click();
  await page.clock.setFixedTime(nextMidday);
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await expect(page.getByTestId(`suggestion-${pending.id}-checked`)).toHaveText(
    new RegExp(`^✓ Checked off · 3 units · ${writtenDay(yesterday)}`, 'u'),
  );
});
