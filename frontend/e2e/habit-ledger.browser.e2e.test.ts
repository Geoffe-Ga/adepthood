import { readFile } from 'node:fs/promises';

import { expect, test, type APIRequestContext } from '@playwright/test';

import {
  backendUrl,
  bearer,
  isoDaysAgo,
  openHabits,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * Issue #3529 — the Ledger behind the Story's "Everything" door holds every
 * figure with its denominator, the raw logs grouped by day, and the series as
 * a file the person keeps.
 *
 * The seam: check-ins written through the real `POST /goal_completions/`
 * become `GET /habits/{id}/story`; the Ledger shows today's log at the time
 * the server recorded it, and Export CSV hands the browser a file whose rows
 * are the server's days and logs.
 */

const HABIT = 'Evening reading';
const SPAN_DAYS = 9;
const UNITS_PER_DAY = 15;
const FULL_HEIGHT = 3200;
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'phone-full', width: 390, height: FULL_HEIGHT },
  { name: 'desktop-full', width: 1280, height: FULL_HEIGHT },
] as const;

async function seedReading(request: APIRequestContext, token: string): Promise<number> {
  const created = await request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name: HABIT,
      icon: '📖',
      energy_cost: 1,
      energy_return: 4,
      start_date: isoDaysAgo(SPAN_DAYS),
      revealed: true,
      goals: {
        target_unit: 'minutes',
        frequency: 1,
        frequency_unit: 'per_day',
        low: 5,
        clear: 15,
        stretch: 30,
      },
    },
  });
  expect(created.ok(), `seeding the habit failed: ${await created.text()}`).toBe(true);
  const habit = (await created.json()) as { id: number; goals: Array<{ id: number }> };
  const goalId = habit.goals[0]?.id;
  if (goalId === undefined) throw new Error('the seeded habit has no goals');
  for (let daysAgo = SPAN_DAYS; daysAgo >= 0; daysAgo -= 1) {
    const logged = await request.post(`${backendUrl()}/goal_completions/`, {
      headers: bearer(token),
      data: {
        goal_id: goalId,
        completed_units: UNITS_PER_DAY,
        ...(daysAgo === 0 ? {} : { completed_on: isoDaysAgo(daysAgo) }),
      },
    });
    expect(logged.ok(), `logging ${daysAgo} days ago failed: ${await logged.text()}`).toBe(true);
  }
  return habit.id;
}

interface StoryLog {
  timestamp: string;
  local_day: string;
}

test('the Ledger shows a log row at its server time and exports the series', async ({
  page,
}, testInfo) => {
  const email = await signUp(page, 'habit-ledger');
  const habitId = await seedReading(page.request, await tokenFor(page.request, email));
  await page.reload();
  await openHabits(page);

  const read = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/habits/${habitId}/story`,
  );
  await page
    .getByTestId('habit-tile')
    .filter({ hasText: HABIT })
    .getByRole('button', { name: 'Story', exact: true })
    .click();
  const story = (await (await read).json()) as { logs: StoryLog[]; today: string };
  const newest = story.logs[0];
  if (newest === undefined) throw new Error('the story carries no logs');

  const sheet = page.getByTestId('habit-story-sheet');
  await sheet.getByTestId('habit-story-everything').click();
  const ledger = sheet.getByTestId('habit-ledger');
  await expect(ledger.getByTestId('habit-ledger-continuity')).toContainText(
    '10 of 10 scheduled days (100%)',
  );
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(newest.timestamp));
  const row = ledger
    .getByTestId(`habit-ledger-day-${newest.local_day}`)
    .getByTestId('habit-ledger-log')
    .first();
  await expect(row).toContainText(time);
  await expect(row).toContainText(`+${UNITS_PER_DAY} minutes`);
  await expect(ledger).not.toContainText(/streak|broken|missed|lost|failed/i);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.screenshot({ path: testInfo.outputPath(`habit-ledger-${viewport.name}.png`) });
  }

  const download = page.waitForEvent('download');
  await ledger.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const file = await download;
  const filename = `adepthood-evening-reading-${story.today}.csv`;
  expect(file.suggestedFilename()).toBe(filename);
  const csv = await readFile(await file.path(), 'utf8');
  expect(csv).toContain('# days\ndate,units,tier,logged,scheduled,met,untimed_units');
  expect(csv).toContain(`${newest.timestamp},${newest.local_day},${UNITS_PER_DAY}`);
  await expect(ledger.getByTestId('habit-ledger-export-saved')).toHaveText(`Saved ${filename}`);
});
