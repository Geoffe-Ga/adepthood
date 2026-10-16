import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  backendUrl,
  seedHabit,
  seedTimerHabit,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';

const HABIT_NAME = 'Morning pages';
const BODY = 'The kettle, the window, and a page before anything else.';
const MINUTE_MS = 60_000;
const MINUTES_GOALS = {
  target_unit: 'minutes',
  frequency: 1,
  frequency_unit: 'per_day',
  low: 10,
  clear: 20,
  stretch: 45,
};
interface GoalRead {
  id: number;
  tier: string;
  target: number;
  target_unit: string;
  frequency_unit: string;
  completions?: Array<{ completed_units: number | null }>;
}
interface HabitRead {
  id: number;
  name: string;
  revealed: boolean;
  start_date: string;
  goals: GoalRead[];
}

async function readHabit(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: number,
): Promise<HabitRead> {
  const response = await request.get(`${backendUrl()}/habits/${id}`, { headers });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<HabitRead>;
}
function loggedUnits(habit: HabitRead): number {
  return habit.goals
    .flatMap((goal) => goal.completions ?? [])
    .reduce((sum, row) => sum + (row.completed_units ?? 0), 0);
}
async function linkedHabitId(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<number | null> {
  const response = await request.get(`${backendUrl()}/ui-flags`, { headers });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { writing_session_habit_id: number | null })
    .writing_session_habit_id;
}
async function account(page: Page, prefix: string) {
  // Simulated sessions stay on one UTC day even when CI starts near midnight.
  const midday = new Date();
  midday.setUTCHours(12, 0, 0, 0);
  await page.clock.install({ time: midday });
  const email = await signUp(page, prefix);
  const { token } = await sessionFor(page.request, email);
  return { token, headers: { Authorization: `Bearer ${token}` } };
}
async function openEntry(page: Page) {
  await page.reload();
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-body-input').fill(BODY);
}
async function startTimer(page: Page, minutes = 20) {
  const folded = page.getByTestId('writing-timer-compact');
  if (await folded.isVisible()) await folded.click();
  await page.getByTestId(`writing-timer-preset-${minutes}`).click();
  await page.getByTestId('writing-timer-start').click();
  await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
}
async function completeTimer(page: Page, minutes = 20) {
  await startTimer(page, minutes);
  await page.clock.fastForward(minutes * MINUTE_MS + 100);
  await expect(page.getByTestId('writing-session-banner')).toBeVisible();
}
function isCompletion(response: { url(): string; request(): { method(): string } }): boolean {
  return (
    new URL(response.url()).pathname === '/goal_completions/' &&
    response.request().method() === 'POST'
  );
}
async function logFullSession(page: Page, minutes = 20) {
  const response = page.waitForResponse(isCompletion);
  await completeTimer(page, minutes);
  const confirmed = await response;
  expect(confirmed.ok()).toBe(true);
  expect(confirmed.request().postDataJSON()).toMatchObject({
    completed_units: minutes,
    via_timer: true,
  });
  return confirmed;
}
async function scaleText(page: Page) {
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>('[dir="auto"]')];
    const sizes = nodes.map(
      (node) => node.dataset.timerBaseSize ?? getComputedStyle(node).fontSize,
    );
    nodes.forEach((node, index) => {
      node.dataset.timerBaseSize = sizes[index];
      node.style.fontSize = `${parseFloat(sizes[index]!) * 2}px`;
      node.style.lineHeight = 'normal';
    });
  });
}
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByTestId('settings-row-writing-habit').click();
  await expect(page.getByTestId('writing-habit-picker')).toBeVisible();
}

async function showTimerAction(page: Page, testId: string) {
  const action = page.getByTestId(testId);
  await action.scrollIntoViewIfNeeded();
  await action.evaluate((node) =>
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }),
  );
  await expect(action).toBeInViewport({ ratio: 1 });
  const box = await action.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect
    .poll(() =>
      action.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return hit !== null && node.contains(hit);
      }),
    )
    .toBe(true);
}

async function expectPlacementGlyphsFit(page: Page) {
  const overflow = await page.getByTestId('save-as-habit-row-10').evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const left = Math.max(0, bounds.left);
    const right = Math.min(innerWidth, bounds.right);
    const top = Math.max(0, bounds.top);
    const bottom = Math.min(innerHeight, bounds.bottom);
    const clipped: string[] = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const appendClippedGlyphs = (node: Node) => {
      const text = node.textContent ?? '';
      for (let index = 0; index < text.length; index += 1) {
        if (/\s/u.test(text[index]!)) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const outside = [...range.getClientRects()].some(
          (glyph) =>
            glyph.left < left - 1 ||
            glyph.right > right + 1 ||
            glyph.top < top - 1 ||
            glyph.bottom > bottom + 1,
        );
        if (outside) clipped.push(text[index]!);
      }
    };
    let textNode = walker.nextNode();
    while (textNode) {
      appendClippedGlyphs(textNode);
      textNode = walker.nextNode();
    }
    return clipped;
  });
  expect(overflow).toEqual([]);
}

test('each timed writing session adds its measured minutes, including early stops, and survives reload', async ({
  page,
}) => {
  const { token, headers } = await account(page, 'writing-measured-minutes');
  const habitId = await seedTimerHabit(page.request, token, HABIT_NAME);
  await openEntry(page);
  await completeTimer(page);
  await page.getByTestId('save-as-habit-accept').click();
  await page.getByTestId(`writing-habit-choose-${habitId}`).click();
  await expect(page.getByTestId('save-as-habit-linked')).toContainText(HABIT_NAME);
  expect(await linkedHabitId(page.request, headers)).toBe(habitId);
  expect(loggedUnits(await readHabit(page.request, headers, habitId))).toBe(0);
  const first = await logFullSession(page);
  await expect(page.getByTestId('writing-session-log-notice')).toHaveText(
    `Logged 20 minutes to ${HABIT_NAME}`,
  );
  expect(loggedUnits(await readHabit(page.request, headers, habitId))).toBe(20);
  const second = await logFullSession(page);
  expect(second.request().headers()['idempotency-key']).not.toBe(
    first.request().headers()['idempotency-key'],
  );
  expect(loggedUnits(await readHabit(page.request, headers, habitId))).toBe(40);
  await startTimer(page);
  await page.clock.fastForward(5 * MINUTE_MS);
  const early = page.waitForResponse(isCompletion);
  await page.getByTestId('writing-timer-stop').click();
  expect((await early).request().postDataJSON()).toMatchObject({
    completed_units: 5,
    via_timer: true,
  });
  await expect(page.getByTestId('writing-session-log-notice')).toHaveText(
    `Logged 5 minutes to ${HABIT_NAME}`,
  );
  await expect(page.getByTestId('save-as-habit-accept')).toHaveCount(0);
  expect(loggedUnits(await readHabit(page.request, headers, habitId))).toBe(45);
  await page.reload();
  expect(loggedUnits(await readHabit(page.request, headers, habitId))).toBe(45);
  expect(await linkedHabitId(page.request, headers)).toBe(habitId);
  expect(
    (await page.request.delete(`${backendUrl()}/habits/${habitId}`, { headers })).status(),
  ).toBe(204);
  expect(await linkedHabitId(page.request, headers)).toBeNull();
});

test('a sessions habit counts one full session and no early-stopped session', async ({ page }) => {
  const { headers } = await account(page, 'writing-full-sessions');
  const created = await page.request.post(`${backendUrl()}/habits/`, {
    headers,
    data: {
      name: 'Writing sessions',
      icon: '★',
      start_date: '2026-01-01',
      energy_cost: 1,
      energy_return: 1,
      revealed: true,
      goals: {
        target_unit: 'sessions',
        frequency: 4,
        frequency_unit: 'per_week',
        low: 1,
        clear: 1,
        stretch: 1,
      },
    },
  });
  expect(created.ok()).toBe(true);
  const id = ((await created.json()) as HabitRead).id;
  expect(
    (
      await page.request.patch(`${backendUrl()}/ui-flags`, {
        headers,
        data: { writing_session_habit_id: id },
      })
    ).ok(),
  ).toBe(true);
  // Observe the persisted link before jumping five minutes: the fake clock also
  // advances fetch timeouts, so it must not outrun initial link hydration.
  await page.reload();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(page.getByTestId('settings-row-writing-habit')).toHaveAccessibleName(
    'Writing timer → Writing sessions',
  );
  await page.goBack();
  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-body-input').fill(BODY);
  const requests: unknown[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/goal_completions/')
      requests.push(request.postDataJSON());
  });
  await startTimer(page);
  await page.clock.fastForward(5 * MINUTE_MS);
  const eligibilityRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/habits/' && response.request().method() === 'GET',
  );
  await page.getByTestId('writing-timer-stop').click();
  expect((await eligibilityRead).ok()).toBe(true);
  expect(loggedUnits(await readHabit(page.request, headers, id))).toBe(0);
  expect(requests).toHaveLength(0);
  const full = page.waitForResponse(isCompletion);
  await completeTimer(page);
  expect((await full).request().postDataJSON()).toMatchObject({
    completed_units: 1,
    via_timer: true,
  });
  await expect(page.getByTestId('writing-session-log-notice')).toHaveText(
    'Logged a session to Writing sessions',
  );
  expect(loggedUnits(await readHabit(page.request, headers, id))).toBe(1);
});

for (const width of [390, 1280]) {
  test(`new timer habit keeps explicit goals and is immediately loggable with ten existing habits at ${width}px and 200% text`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const { token, headers } = await account(page, `writing-new-goals-${width}`);
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 10; i += 1)
      await seedHabit(page.request, token, `Existing habit ${i + 1}`, today, true);
    await openEntry(page);
    await completeTimer(page);
    await page.getByTestId('save-as-habit-accept').click();
    await page.getByTestId('writing-habit-new').click();
    for (const [display, input, save] of [
      ['goal-target-display-low', 'goal-target-input-low', 'goal-target-save-low'],
      ['goal-target-display-clear', 'goal-target-input-clear', 'goal-target-save-clear'],
      ['goal-target-display-stretch', 'goal-target-input-stretch', 'goal-target-save-stretch'],
      ['goal-frequency-display', 'goal-frequency-input', 'goal-frequency-save'],
    ]) {
      await showTimerAction(page, display!);
      await page.screenshot({ path: testInfo.outputPath(`${display}-normal.png`) });
      await page.getByTestId(display!).click();
      await showTimerAction(page, input!);
      await showTimerAction(page, save!);
      await page.screenshot({ path: testInfo.outputPath(`${input}-normal.png`) });
      await page.getByTestId(save!).click();
    }
    await scaleText(page);
    for (const tier of ['low', 'clear', 'stretch']) {
      await page.getByTestId(`goal-target-display-${tier}`).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`goals-${tier}-200.png`) });
    }
    for (const id of [
      'goal-target-unit-minutes',
      'goal-target-unit-sessions',
      'goal-frequency-unit-per_day',
      'goal-frequency-unit-per_week',
      'writing-habit-goals-save',
    ]) {
      await showTimerAction(page, id);
      await page.screenshot({ path: testInfo.outputPath(`${id}-200.png`) });
    }
    await showTimerAction(page, 'writing-habit-goals-save');
    await page.getByTestId('writing-habit-goals-save').click();
    for (let index = 0; index < 10; index += 1) {
      const later = page.getByTestId('save-as-habit-move-later');
      await later.scrollIntoViewIfNeeded();
      await later.click();
    }
    await scaleText(page);
    await showTimerAction(page, 'save-as-habit-move-earlier');
    await showTimerAction(page, 'save-as-habit-move-later');
    await showTimerAction(page, 'save-as-habit-confirm');
    await showTimerAction(page, 'save-as-habit-cancel');
    await page.screenshot({ path: testInfo.outputPath('new-habit-last-position-200.png') });
    await expectPlacementGlyphsFit(page);
    const create = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/habits/' && response.request().method() === 'POST',
    );
    await page.getByTestId('save-as-habit-confirm').click();
    const kept = await create;
    expect(kept.ok()).toBe(true);
    expect(kept.request().postDataJSON()).toMatchObject({ revealed: true, goals: MINUTES_GOALS });
    const newHabit = (await kept.json()) as HabitRead;
    expect(newHabit.revealed).toBe(true);
    expect(new Date(newHabit.start_date).getTime()).toBeGreaterThan(new Date(today).getTime());
    await expect.poll(() => linkedHabitId(page.request, headers)).toBe(newHabit.id);
    const response = await logFullSession(page, 10);
    expect((await response.json()) as unknown).toMatchObject({ day_units: 10 });
    await expect(page.getByTestId('writing-session-log-notice')).toHaveText(
      'Logged 10 minutes to Journaling',
    );
    expect(loggedUnits(await readHabit(page.request, headers, newHabit.id))).toBe(10);
    await scaleText(page);
    await page.clock.runFor(4_000);
    await expect(page.getByTestId('toast-container')).toHaveCount(0);
    await page.getByTestId('writing-session-log-notice').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('logged-new-habit-200.png') });
    await page.reload();
    expect(loggedUnits(await readHabit(page.request, headers, newHabit.id))).toBe(10);
  });
}

test('Settings confirms an unsupported habit’s new units and every goal before linking it', async ({
  page,
}, testInfo) => {
  const { token, headers } = await account(page, 'writing-settings-goals');
  const id = await seedHabit(page.request, token, 'My existing writing habit', '2026-01-01', true);
  await page.reload();
  await openSettings(page);
  await expect(page.getByTestId(`writing-habit-choose-${id}`)).toHaveCount(0);
  await page.getByTestId(`writing-habit-configure-${id}`).click();
  await scaleText(page);
  for (const tier of ['low', 'clear', 'stretch']) {
    await page.getByTestId(`goal-target-display-${tier}`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`settings-goals-${tier}-200.png`) });
  }
  await showTimerAction(page, 'goal-target-unit-sessions');
  await page.getByTestId('goal-target-unit-sessions').click();
  await page.getByTestId('goal-frequency-unit-per_week').click();
  const linkSaved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/ui-flags' && response.request().method() === 'PATCH',
  );
  await showTimerAction(page, 'writing-habit-goals-save');
  await page.getByTestId('writing-habit-goals-save').click();
  expect((await linkSaved).ok()).toBe(true);
  await expect(page.getByTestId('writing-habit-goals')).toHaveCount(0);
  expect(await linkedHabitId(page.request, headers)).toBe(id);
  const confirmed = await readHabit(page.request, headers, id);
  expect(confirmed.goals).toHaveLength(3);
  expect(
    confirmed.goals.every(
      (goal) =>
        goal.target_unit === 'sessions' && goal.frequency_unit === 'per_week' && goal.target === 1,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('settings-confirmed-link.png') });
  await page.reload();
  expect(await linkedHabitId(page.request, headers)).toBe(id);
});

test('a committed log whose first reply is lost retries the same operation and adds minutes once', async ({
  page,
}) => {
  const { token, headers } = await account(page, 'writing-log-receipt');
  const id = await seedTimerHabit(page.request, token, 'Retry-safe writing');
  expect(
    (
      await page.request.patch(`${backendUrl()}/ui-flags`, {
        headers,
        data: { writing_session_habit_id: id },
      })
    ).ok(),
  ).toBe(true);
  await openEntry(page);
  const keys: string[] = [];
  let committed: (() => void) | undefined;
  const firstCommitted = new Promise<void>((resolve) => {
    committed = resolve;
  });
  await page.route('**/goal_completions/', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (keys.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'reply_unavailable' }),
      });
      committed!();
    } else await route.fulfill({ response });
  });
  await completeTimer(page);
  await firstCommitted;
  await page.clock.runFor(10_000);
  await expect(page.getByTestId('writing-session-log-notice')).toHaveText(
    'Logged 20 minutes to Retry-safe writing',
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe('');
  expect(keys[1]).toBe(keys[0]);
  expect(loggedUnits(await readHabit(page.request, headers, id))).toBe(20);
});

async function expectPrivacyLabelsFit(page: Page): Promise<void> {
  // Measure the touch targets after the journal sheet's entrance has settled.
  await expect
    .poll(() =>
      page.getByTestId('journal-sheet').evaluate((sheet) => {
        const style = getComputedStyle(sheet);
        return {
          offset: new DOMMatrixReadOnly(style.transform).m42,
          opacity: style.opacity,
        };
      }),
    )
    .toEqual({ offset: 0, opacity: '1' });
  const frames = await page.getByRole('radiogroup', { name: 'Entry privacy' }).evaluate((group) =>
    ['public', 'personal', 'intimate'].map((tier) => {
      const option = group.querySelector<HTMLElement>(`[data-testid="privacy-tier-${tier}"]`);
      const label = option?.querySelector<HTMLElement>('[dir="auto"]');
      if (!option || !label) throw new Error(`Missing rendered ${tier} privacy option`);
      const frame = option.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      const overflow = [...range.getClientRects()].filter(
        (glyphs) =>
          glyphs.left < frame.left - 1 ||
          glyphs.right > frame.right + 1 ||
          glyphs.top < frame.top - 1 ||
          glyphs.bottom > frame.bottom + 1,
      ).length;
      return { tier, width: frame.width, height: frame.height, overflow };
    }),
  );
  for (const frame of frames) {
    expect(frame.width, JSON.stringify(frame)).toBeGreaterThanOrEqual(44);
    expect(frame.height, JSON.stringify(frame)).toBeGreaterThanOrEqual(44);
    expect(frame.overflow, JSON.stringify(frame)).toBe(0);
  }
}

async function doublePrivacyLabels(page: Page): Promise<void> {
  await page.locator('[role="radio"] [dir="auto"]').evaluateAll((labels) => {
    for (const label of labels) {
      const text = label as HTMLElement;
      text.style.fontSize = `${parseFloat(getComputedStyle(text).fontSize) * 2}px`;
      text.style.lineHeight = 'normal';
    }
  });
}

for (const width of [390, 1280]) {
  test(`privacy labels reflow and retain the saved choice at ${width}px and doubled label text (#3298)`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const email = await signUp(page, 'privacy-label-reflow');
    const session = await sessionFor(page.request, email);
    await page.getByTestId('journal-new-entry').click();
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
    );
    await page.getByTestId('journal-body-input').fill('A private page with a readable choice.');
    const id = ((await (await created).json()) as { id: number }).id;
    await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
    await page.getByRole('radiogroup', { name: 'Entry privacy' }).scrollIntoViewIfNeeded();
    await expectPrivacyLabelsFit(page);
    await doublePrivacyLabels(page);
    await expectPrivacyLabelsFit(page);
    await page.getByTestId('privacy-tier-public').focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('privacy-tier-public')).toHaveAttribute('aria-checked', 'true');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/journal/${id}` &&
        response.request().postDataJSON().classification === 'intimate',
    );
    await page.getByTestId('privacy-tier-intimate').click();
    expect((await saved).ok()).toBe(true);
    const stored = await page.request.get(`${backendUrl()}/journal/${id}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    expect(((await stored.json()) as { classification: string }).classification).toBe('intimate');
    await page.getByTestId('journal-close-entry').click();
    await page.reload();
    await page.getByTestId(`journal-shelf-open-${id}`).click();
    await expect(page.locator('[data-testid="privacy-tier-intimate"]:visible')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await doublePrivacyLabels(page);
    await expectPrivacyLabelsFit(page);
    await page.screenshot({
      path: testInfo.outputPath(`privacy-labels-${width}-doubled.png`),
      fullPage: true,
    });
  });
}
