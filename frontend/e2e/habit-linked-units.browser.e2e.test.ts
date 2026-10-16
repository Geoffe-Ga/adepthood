import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { backendUrl, bearer, openHabits, sessionFor, signUp } from './journalHabitsBrowserSupport';

/**
 * #3154: a habit a timer logs to can only count what the timer measures.
 *
 * The journal's writing timer is linked to "Journaling" on the server
 * (`PATCH /ui-flags`), and the Habits goal editor, reading that link through
 * the real client, offers only `minutes` / `sessions` and `per day` /
 * `per week`, says the timer does the logging, and saves a pick through the
 * real `PUT /habits/{id}/goals/units`. A habit nothing is linked to keeps all
 * twenty units.
 *
 * The 422 is reached for real, not stubbed: the editor of an unlinked habit is
 * opened first, the habit is then linked out of band (as another device
 * would), and the stale editor's "reps" is refused by the backend guard. The
 * toast carries the server's reason and the tiers return to minutes.
 */

const LINKED = 'Journaling';
const UNLINKED = 'Evening walk';
const TIMER_NOTE = 'Logged automatically by the timer — minutes, or one session per sitting.';
const REFUSAL =
  'A timer logs this habit, so it counts in minutes or sessions only. Choose one of those.';
const TARGET_UNIT_COUNT = 20;
const FREQUENCY_UNIT_COUNT = 4;
/** The repo's touch floor (`touchTarget.minimum`), in CSS pixels. */
const TOUCH_MIN = 44;
/** A common phone height: the linked editor is tallest here, against the card's 80% cap. */
const VIEWPORT_HEIGHT = 844;
/** Rounding slack for a measured box. */
const SUB_PIXEL = 0.5;

interface GoalRow {
  target_unit: string;
  frequency_unit: string;
}

/** A revealed habit whose goals already count minutes, so a timer may be linked to it. */
async function seedMinutesHabit(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<number> {
  const response = await request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name,
      icon: '★',
      energy_cost: 2,
      energy_return: 4,
      start_date: '2026-01-01',
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
  expect(response.ok(), `seeding ${name} failed`).toBe(true);
  return ((await response.json()) as { id: number }).id;
}

async function linkWritingTimer(
  request: APIRequestContext,
  token: string,
  habitId: number,
): Promise<void> {
  const response = await request.patch(`${backendUrl()}/ui-flags`, {
    headers: bearer(token),
    data: { writing_session_habit_id: habitId },
  });
  expect(response.ok(), 'linking the writing timer failed').toBe(true);
}

async function goalsOf(request: APIRequestContext, token: string, habitId: number) {
  const response = await request.get(`${backendUrl()}/habits/${habitId}`, {
    headers: bearer(token),
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { goals: GoalRow[] }).goals;
}

async function openEditor(page: Page, name: string): Promise<Locator> {
  await page.getByTestId('habit-tile').filter({ hasText: name }).click();
  await page.getByTestId('goal-modal-edit-toggle').click();
  const editor = page.getByTestId('goal-target-editor');
  await expect(editor).toBeVisible();
  return editor;
}

async function closeModal(page: Page): Promise<void> {
  await page.getByTestId('goal-modal-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(page.getByTestId('goal-modal-backdrop')).toHaveCount(0);
}

/** Every chip of a row, by its value (the testID suffix). */
function chips(editor: Locator, row: string): Locator {
  return editor.getByTestId(row).locator(`[data-testid^="${row}-"]`);
}

/** Double the note's and the chips' type, the way a 200% text setting would. */
async function doubleEditorText(editor: Locator): Promise<void> {
  await editor.evaluate((root) => {
    const targets = root.querySelectorAll<HTMLElement>(
      '[data-testid="goal-timer-note"], [data-testid^="goal-target-unit-"] > div, [data-testid^="goal-frequency-unit-"] > div',
    );
    for (const node of targets) {
      const style = getComputedStyle(node);
      node.style.fontSize = `${Number.parseFloat(style.fontSize) * 2}px`;
      node.style.lineHeight = `${Number.parseFloat(style.lineHeight) * 2}px`;
    }
  });
}

/** The note sits inside the viewport, unclipped; every chip clears the touch floor. */
async function expectReadableEditor(page: Page, editor: Locator): Promise<void> {
  const note = editor.getByTestId('goal-timer-note');
  await note.scrollIntoViewIfNeeded();
  const box = await note.boundingBox();
  const viewportWidth = page.viewportSize()?.width ?? 0;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-SUB_PIXEL);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth + SUB_PIXEL);
  const clipped = await note.evaluate((node) => node.scrollHeight > node.clientHeight + 1);
  expect(clipped, 'the timer note is clipped').toBe(false);
  for (const row of ['goal-target-unit', 'goal-frequency-unit']) {
    for (const chip of await chips(editor, row).all()) {
      const chipBox = await chip.boundingBox();
      expect(chipBox!.height).toBeGreaterThanOrEqual(TOUCH_MIN - SUB_PIXEL);
      expect(chipBox!.width).toBeGreaterThanOrEqual(TOUCH_MIN - SUB_PIXEL);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewportWidth,
  );
  // The editor scrolls inside the card: the log row never spills out of it.
  const card = await page.getByTestId('goal-modal-card').boundingBox();
  const log = await page.getByRole('button', { name: 'Log Units' }).boundingBox();
  expect(log!.y + log!.height).toBeLessThanOrEqual(card!.y + card!.height + SUB_PIXEL);
}

for (const width of [390, 1280]) {
  test(`a timer-fed habit's editor offers only minutes or sessions at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    const email = await signUp(page, 'habit-linked-units');
    const { token } = await sessionFor(page.request, email);
    const linkedId = await seedMinutesHabit(page.request, token, LINKED);
    const unlinkedId = await seedMinutesHabit(page.request, token, UNLINKED);
    await linkWritingTimer(page.request, token, linkedId);
    await page.reload();
    await openHabits(page);

    // --- The linked habit: two units, two cadences, and the note. ---
    let editor = await openEditor(page, LINKED);
    await expect(editor.getByText(TIMER_NOTE)).toBeVisible();
    await expect(chips(editor, 'goal-target-unit')).toHaveCount(2);
    await expect(editor.getByTestId('goal-target-unit-minutes')).toBeVisible();
    await expect(editor.getByTestId('goal-target-unit-sessions')).toBeVisible();
    await expect(chips(editor, 'goal-frequency-unit')).toHaveCount(2);
    await expect(editor.getByTestId('goal-frequency-unit-per_day')).toBeVisible();
    await expect(editor.getByTestId('goal-frequency-unit-per_week')).toBeVisible();
    await expect(editor.getByTestId('goal-direction-row')).toHaveCount(0);
    await expectReadableEditor(page, editor);
    await page.screenshot({ path: info.outputPath(`linked-editor-${width}-normal.png`) });

    const [saved] = await Promise.all([
      page.waitForResponse(
        (reply) =>
          reply.request().method() === 'PUT' &&
          new URL(reply.url()).pathname === `/habits/${linkedId}/goals/units`,
      ),
      editor.getByTestId('goal-target-unit-sessions').click(),
    ]);
    expect(saved.ok(), 'the sessions pick did not save').toBe(true);
    // Every tier restates itself in the new unit.
    await expect(editor).toContainText('sessions a day');
    expect(
      (await goalsOf(page.request, token, linkedId)).every((g) => g.target_unit === 'sessions'),
    ).toBe(true);

    // Focus reaches a chip from the keyboard and lands visibly on it.
    await editor.getByTestId('goal-frequency-unit-per_week').focus();
    await expect(editor.getByTestId('goal-frequency-unit-per_week')).toBeFocused();

    await doubleEditorText(editor);
    await expectReadableEditor(page, editor);
    await page.screenshot({ path: info.outputPath(`linked-editor-${width}-2x.png`) });
    await closeModal(page);

    // --- The unlinked habit keeps every unit; then it is linked elsewhere. ---
    editor = await openEditor(page, UNLINKED);
    await expect(chips(editor, 'goal-target-unit')).toHaveCount(TARGET_UNIT_COUNT);
    await expect(chips(editor, 'goal-frequency-unit')).toHaveCount(FREQUENCY_UNIT_COUNT);
    await expect(editor.getByText(TIMER_NOTE)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`unlinked-editor-${width}.png`) });

    await linkWritingTimer(page.request, token, unlinkedId);
    const [refused] = await Promise.all([
      page.waitForResponse(
        (reply) =>
          reply.request().method() === 'PUT' &&
          new URL(reply.url()).pathname === `/habits/${unlinkedId}/goals/units`,
      ),
      editor.getByTestId('goal-target-unit-reps').click(),
    ]);
    expect(refused.status()).toBe(422);
    await expect(page.getByTestId('toast-message')).toHaveText(REFUSAL);
    await expect(editor).toContainText('minutes a day');
    await expect(editor).not.toContainText('reps a day');
    expect(
      (await goalsOf(page.request, token, unlinkedId)).every((g) => g.target_unit === 'minutes'),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`refused-${width}.png`) });
  });
}
