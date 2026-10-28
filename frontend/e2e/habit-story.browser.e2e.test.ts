import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { STORY_CLOSE_LABEL } from '../src/features/Habits/components/modalCloseLabels';

import {
  backendUrl,
  bearer,
  isoDaysAgo,
  openHabits,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * Issue #3526 — one tap from a habit's tile opens its Story, drawn from what
 * the server computed (#3524) rather than anything the client approximates.
 *
 * The seam this crosses is the whole point: check-ins written through the real
 * `POST /goal_completions/` become a server-computed `GET /habits/{id}/story`,
 * and the sheet a person opens from the tile shows those figures with their
 * denominators. Twenty scheduled days are seeded, seventeen of them kept, with
 * rests three and five days into the past, so every Glance figure is a number
 * the spec can predict: the run since the last rest, the longest run, the two
 * returns after a rest, and seventeen days with the habit out of twenty.
 */

const HABIT = 'Morning sitting';
/** The habit began this many days ago, so twenty days are scheduled through today. */
const SPAN_DAYS = 19;
/** Days back that rested; every other day logs twenty minutes, a Clear day. */
const REST_DAYS = new Set([5, 6, 12]);
const UNITS_PER_DAY = 20;
/** The sheet scrolls inside its modal, so the full-length captures use a tall window. */
const FULL_SHEET_HEIGHT = 2400;
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone-full', width: 390, height: FULL_SHEET_HEIGHT },
  { name: 'desktop-full', width: 1280, height: FULL_SHEET_HEIGHT },
] as const;

async function seedPages(request: APIRequestContext, token: string): Promise<number> {
  const created = await request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name: HABIT,
      icon: '🪷',
      energy_cost: 2,
      energy_return: 5,
      start_date: isoDaysAgo(SPAN_DAYS),
      revealed: true,
      goals: {
        target_unit: 'minutes',
        frequency: 1,
        frequency_unit: 'per_day',
        low: 10,
        clear: 20,
        stretch: 45,
      },
    },
  });
  expect(created.ok(), `seeding the habit failed: ${await created.text()}`).toBe(true);
  const habit = (await created.json()) as { id: number; goals: Array<{ id: number }> };
  const goalId = habit.goals[0]?.id;
  if (goalId === undefined) throw new Error('the seeded habit has no goals');
  for (let daysAgo = SPAN_DAYS; daysAgo >= 0; daysAgo -= 1) {
    if (REST_DAYS.has(daysAgo)) continue;
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

async function openStory(page: Page, habitId: number) {
  const read = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/habits/${habitId}/story`,
  );
  await page
    .getByTestId('habit-tile')
    .filter({ hasText: HABIT })
    .getByRole('button', { name: 'Story', exact: true })
    .click();
  expect((await read).status()).toBe(200);
  const sheet = page.getByTestId('habit-story-sheet');
  await expect(sheet.getByTestId('habit-story-glance')).toBeVisible();
  return sheet;
}

test('a habit tile opens a Story drawn from the server, with its denominators', async ({
  page,
}, testInfo) => {
  const email = await signUp(page, 'habit-story');
  const habitId = await seedPages(page.request, await tokenFor(page.request, email));
  await page.reload();
  await openHabits(page);

  const sheet = await openStory(page, habitId);
  const glance = sheet.getByTestId('habit-story-glance');
  await expect(glance.getByTestId('habit-story-glance-current')).toContainText('Current run');
  await expect(glance.getByTestId('habit-story-glance-current')).toContainText('5 days');
  await expect(glance.getByTestId('habit-story-glance-longest')).toContainText('7 days');
  await expect(glance.getByTestId('habit-story-glance-returns')).toContainText('2');
  await expect(glance.getByTestId('habit-story-glance-with')).toContainText('17');
  await expect(glance.getByTestId('habit-story-glance-with')).toContainText('of 20 scheduled');
  await expect(sheet.getByTestId('habit-story-rate')).toHaveText(
    '17 of 20 scheduled days in the last 21 days · all time 17 of 20',
  );
  await expect(sheet.getByTestId('habit-story-heat-grid')).toBeVisible();
  await expect(sheet.getByTestId('habit-story-tier-stack')).toBeVisible();
  await expect(sheet).not.toContainText(/streak|broken|missed|lost|failed/i);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.screenshot({ path: testInfo.outputPath(`habit-story-${viewport.name}.png`) });
  }

  // Everything opens the raw log, newest first; back returns to the Story.
  await sheet.getByTestId('habit-story-everything').click();
  await expect(sheet.getByTestId('habit-ledger')).toContainText('+20 minutes');
  await sheet.getByRole('button', { name: 'Back to the story' }).click();
  await expect(sheet.getByTestId('habit-story-glance')).toBeVisible();

  await sheet.getByRole('button', { name: STORY_CLOSE_LABEL, exact: true }).click();
  await expect(page.getByTestId('habit-story-sheet')).toHaveCount(0);
  await expect(page.getByTestId('habit-tile').filter({ hasText: HABIT })).toContainText(
    '5-DAY RUN',
  );
  await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
  await page.screenshot({ path: testInfo.outputPath('habit-story-tile-phone.png') });
});
