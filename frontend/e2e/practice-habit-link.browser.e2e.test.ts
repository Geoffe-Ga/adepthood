import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';

const MINUTE = 60_000;
interface Adoption {
  id: number;
  practice_id: number;
  habit_id: number | null;
  end_date: string | null;
}
interface HabitRead {
  id: number;
  name: string;
  revealed: boolean;
  goals: Array<{
    target: number;
    target_unit: string;
    tier: string;
    frequency: number;
    frequency_unit: string;
    completions?: Array<{ completed_units: number | null }>;
  }>;
}
async function press(control: Locator) {
  await expect(control).toBeVisible();
  await control.scrollIntoViewIfNeeded();
  await control.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(control).toBeEnabled();
  await control.click();
}
async function openPractice(page: Page) {
  await page.getByRole('button', { name: /^Open \w+ menu$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Practice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Practice menu' })).toBeVisible();
}
async function adoption(page: Page, token: string): Promise<Adoption> {
  const response = await page.request.get(`${backendUrl()}/user-practices/`, {
    headers: bearer(token),
  });
  expect(response.ok()).toBe(true);
  const row = ((await response.json()) as Adoption[]).find((item) => item.end_date === null);
  if (!row) throw new Error('No persisted active practice');
  return row;
}
async function arrange(page: Page, width: number, prefix: string) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.clock.install({ time: Date.now() - 6 * 60 * MINUTE });
  const email = await signUp(page, prefix);
  const token = await tokenFor(page.request, email);
  await openPractice(page);
  const response = await page.request.get(`${backendUrl()}/practices/?stage_number=1`, {
    headers: bearer(token),
  });
  expect(response.ok()).toBe(true);
  const row = ((await response.json()) as Array<{ id: number; name: string }>).find(
    (item) => item.name === 'Body Scan',
  );
  if (!row) throw new Error('Seeded Body Scan missing');
  await press(page.getByTestId('practice-tab-catalog'));
  await page.getByTestId('practice-catalog-search').fill(row.name);
  await press(page.getByTestId(`practice-catalog-row-${row.id}`));
  await press(page.getByTestId('practice-detail-use-for-stage'));
  const saved = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === '/user-practices/' && reply.request().method() === 'POST',
  );
  await press(page.getByTestId('practice-detail-stage-pick-1'));
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await openPractice(page);
  await expect(page.getByTestId('ritual-start')).toBeVisible();
  return { token, row: await adoption(page, token) };
}
function practicePost(response: { url(): string; request(): { method(): string } }) {
  return (
    new URL(response.url()).pathname === '/practice-sessions/' &&
    response.request().method() === 'POST'
  );
}
function habitPost(response: { url(): string; request(): { method(): string } }) {
  return (
    new URL(response.url()).pathname === '/goal_completions/' &&
    response.request().method() === 'POST'
  );
}
async function manual(page: Page, minutes: number) {
  await page.getByRole('button', { name: 'Open Practice menu' }).click();
  await press(page.getByTestId('practice-drawer-log'));
  await page.getByTestId('log-session-duration').fill(String(minutes));
  const saved = page.waitForResponse(practicePost);
  await press(page.getByTestId('log-session-save'));
  const response = await saved;
  expect(response.status(), await response.text()).toBe(201);
  return response;
}
async function timed(page: Page) {
  await press(page.getByTestId('ritual-start'));
  await page.clock.fastForward(5 * MINUTE + 1000);
  await expect(page.getByTestId('insight-capture-modal')).toBeVisible();
  const saved = page.waitForResponse(practicePost);
  await press(page.getByTestId('insight-skip'));
  const response = await saved;
  expect(response.status(), await response.text()).toBe(201);
  return response;
}
async function readHabit(page: Page, token: string, id: number): Promise<HabitRead> {
  const response = await page.request.get(`${backendUrl()}/habits/${id}`, {
    headers: bearer(token),
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<HabitRead>;
}
function units(row: HabitRead) {
  return row.goals
    .flatMap((goal) => goal.completions ?? [])
    .reduce((sum, item) => sum + (item.completed_units ?? 0), 0);
}
async function scale(page: Page, value: number) {
  await page.evaluate((factor) => {
    const nodes = [...document.querySelectorAll<HTMLElement>('[dir="auto"]')];
    const bases = nodes.map(
      (node) => node.dataset.practiceHabitBase ?? getComputedStyle(node).fontSize,
    );
    nodes.forEach((node, index) => {
      const base = bases[index];
      if (!base) throw new Error('Unmeasured text');
      node.dataset.practiceHabitBase = base;
      node.style.fontSize = `${parseFloat(base) * factor}px`;
      node.style.lineHeight = 'normal';
    });
  }, value);
}
async function glyphsFit(scope: Locator) {
  const clipped = await scope.evaluate((root) => {
    const failures: string[] = [];
    const inspect = (node: HTMLElement) => {
      const box = node.getBoundingClientRect();
      const inspectText = (text: Node) => {
        const value = text.textContent ?? '';
        for (let n = 0; n < value.length; n++) {
          if (/\s/u.test(value[n]!)) continue;
          const range = document.createRange();
          range.setStart(text, n);
          range.setEnd(text, n + 1);
          const outside = [...range.getClientRects()].some(
            (glyph) =>
              glyph.left < box.left - 1 ||
              glyph.right > box.right + 1 ||
              glyph.top < box.top - 1 ||
              glyph.bottom > box.bottom + 1,
          );
          if (outside) failures.push(value[n]!);
        }
      };
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      while (text) {
        inspectText(text);
        text = walker.nextNode();
      }
    };
    for (const node of root.querySelectorAll<HTMLElement>('[dir="auto"]')) {
      if (node.getClientRects().length > 0) inspect(node);
    }
    return failures;
  });
  expect(clipped).toEqual([]);
}

async function frame(page: Page, info: TestInfo, name: string, scope: Locator, control: Locator) {
  for (const factor of [1, 2]) {
    await scale(page, factor);
    await control.scrollIntoViewIfNeeded();
    await control.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    if (name === 'session-cadence') {
      await control.focus();
      await page.getByTestId('goal-frequency-unit').hover();
      await page.mouse.wheel(1000, 0);
    }
    // Settle real entering and outgoing sibling modals at each text scale.
    await page.evaluate(async () => {
      const finite = document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().iterations));
      await Promise.all(finite.map((animation) => animation.finished));
    });
    await expect(page.getByTestId('log-session-overlay')).toHaveCount(0);
    await glyphsFit(scope);
    const box = await control.boundingBox();
    if (!box) throw new Error('Control geometry missing');
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    await expect(control).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        control.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          return hit !== null && (node === hit || node.contains(hit));
        }),
      )
      .toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}-${factor}x.png`) });
  }
  await scale(page, 1);
}

async function refuseThenHoldLink(page: Page, adoptionId: number) {
  let release!: () => void;
  let attempts = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const url = `**/user-practices/${adoptionId}/habit`;
  await page.route(url, async (route) => {
    expect(route.request().method()).toBe('PATCH');
    attempts += 1;
    if (attempts === 1) await route.abort('failed');
    else {
      await gate;
      await route.continue();
    }
  });
  return { release, attempts: () => attempts, url };
}

for (const width of [390, 1280]) {
  test(`new session habit persists, accumulates and clears at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    const { token, row } = await arrange(page, width, `practice-link-new-${width}`);
    await manual(page, 5);
    await expect(page.getByTestId('practice-habit-offer')).toBeVisible();
    await frame(
      page,
      info,
      'invitation',
      page.getByTestId('practice-habit-offer'),
      page.getByTestId('practice-habit-offer-link'),
    );
    await press(page.getByTestId('practice-habit-offer-link'));
    await frame(
      page,
      info,
      'picker',
      page.getByTestId('practice-habit-picker'),
      page.getByTestId('practice-habit-new'),
    );
    await press(page.getByTestId('practice-habit-new'));
    const form = page.getByTestId('writing-habit-goals');
    await expect(form).toBeVisible();
    await frame(page, info, 'session-goals', form, page.getByTestId('writing-habit-goals-save'));
    await frame(
      page,
      info,
      'session-cadence',
      form,
      page.getByTestId('goal-frequency-unit-per_week'),
    );
    const linkFault = await refuseThenHoldLink(page, row.id);
    const created = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === '/habits/' && reply.request().method() === 'POST',
    );
    const linked = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === `/user-practices/${row.id}/habit` &&
        reply.request().method() === 'PATCH',
    );
    await page.getByTestId('writing-habit-goals-save').focus();
    await page.keyboard.press('Enter');
    const create = await created;
    expect(create.status(), await create.text()).toBe(200);
    expect(create.request().postDataJSON()).toMatchObject({
      revealed: true,
      goals: {
        target_unit: 'sessions',
        frequency: 4,
        frequency_unit: 'per_week',
        low: 1,
        clear: 1,
        stretch: 1,
      },
    });
    const habit = (await create.json()) as HabitRead;
    const retry = page.getByTestId('practice-habit-retry-link');
    try {
      await expect(retry).toBeVisible();
      await frame(
        page,
        info,
        'saved-link-retry',
        page.getByTestId('practice-habit-creation'),
        retry,
      );
      const pending = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname === `/user-practices/${row.id}/habit` &&
          request.method() === 'PATCH',
      );
      await retry.focus();
      await page.keyboard.press('Enter');
      await pending;
      await expect(retry).toBeDisabled();
      await expect(
        page.getByText(
          'Habit saved. We could not confirm its practice link. Try linking it again.',
          { exact: true },
        ),
      ).toHaveCount(0);
    } finally {
      linkFault.release();
    }
    expect((await linked).ok()).toBe(true);
    expect(linkFault.attempts()).toBe(2);
    await page.unroute(linkFault.url);

    expect((await adoption(page, token)).habit_id).toBe(habit.id);
    const first = page.waitForResponse(habitPost);
    await timed(page);
    const log = await first;
    expect(log.ok(), await log.text()).toBe(true);
    expect(log.request().postDataJSON()).toMatchObject({ completed_units: 1, via_timer: true });
    const second = page.waitForResponse(habitPost);
    await manual(page, 6);
    const manualLog = await second;
    expect(manualLog.ok()).toBe(true);
    expect(manualLog.request().postDataJSON()).toMatchObject({ completed_units: 1 });
    expect(manualLog.request().postDataJSON()).not.toHaveProperty('via_timer');
    expect(units(await readHabit(page, token, habit.id))).toBe(2);
    await page.reload();
    await openPractice(page);
    await expect(page.getByTestId('practice-linked-habit')).toContainText('Body Scan');
    await page.getByRole('button', { name: 'Open Practice menu' }).click();
    await press(page.getByTestId('practice-drawer-link-habit'));
    const cleared = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === `/user-practices/${row.id}/habit` &&
        reply.request().method() === 'PATCH',
    );
    await press(page.getByTestId('practice-habit-clear'));
    expect((await cleared).ok()).toBe(true);
    await page.reload();
    await openPractice(page);
    expect((await adoption(page, token)).habit_id).toBeNull();
    await manual(page, 5);
    await expect(page.getByTestId('practice-habit-offer')).toHaveCount(0);
    expect(units(await readHabit(page, token, habit.id))).toBe(2);
  });

  test(`existing minute habit keeps saved practice when its log fails at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    const { token, row } = await arrange(page, width, `practice-link-minute-${width}`);
    // Arrange an already-owned eligible habit; adoption, link and every sitting use real UI writes.
    const seed = await page.request.post(`${backendUrl()}/habits/`, {
      headers: bearer(token),
      data: {
        name: 'Quiet measured minutes',
        energy_cost: 2,
        energy_return: 4,
        start_date: await page.evaluate(() => new Date().toISOString().slice(0, 10)),
        icon: '★',
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
    expect(seed.status(), await seed.text()).toBe(200);
    const habit = (await seed.json()) as HabitRead;
    await page.reload();
    await openPractice(page);
    await expect(page.getByTestId('practice-identity-title')).toHaveText('Body Scan');
    await manual(page, 4);
    await press(page.getByTestId('practice-habit-offer-link'));
    await frame(
      page,
      info,
      'existing-minutes',
      page.getByTestId('practice-habit-picker'),
      page.getByTestId(`practice-habit-choose-${habit.id}`),
    );
    await press(page.getByTestId('practice-habit-cancel'));
    await page.getByRole('button', { name: 'Open Practice menu' }).click();
    await press(page.getByTestId('practice-drawer-link-habit'));
    const linked = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname.endsWith('/habit') && reply.request().method() === 'PATCH',
    );
    await press(page.getByTestId(`practice-habit-choose-${habit.id}`));
    expect((await linked).ok()).toBe(true);
    const completed = page.waitForResponse(habitPost);
    await manual(page, 7);
    const log = await completed;
    expect(log.ok(), await log.text()).toBe(true);
    expect(log.request().postDataJSON()).toMatchObject({ completed_units: 7 });
    expect(log.request().postDataJSON()).not.toHaveProperty('via_timer');
    expect(units(await readHabit(page, token, habit.id))).toBe(7);
    const timedCompletion = page.waitForResponse(habitPost);
    await timed(page);
    const timedLog = await timedCompletion;
    expect(timedLog.ok(), await timedLog.text()).toBe(true);
    expect(timedLog.request().postDataJSON()).toMatchObject({
      completed_units: 5,
      via_timer: true,
    });
    expect(units(await readHabit(page, token, habit.id))).toBe(12);
    await page.route('**/goal_completions/', (route) => route.abort('failed'));
    await manual(page, 8);
    await expect(
      page.getByText("Couldn't log to Quiet measured minutes", { exact: true }),
    ).toBeVisible();
    await frame(
      page,
      info,
      'failed-habit-keeps-practice',
      page.getByTestId('practice-habit-controls'),
      page.getByTestId('practice-habit-change'),
    );
    await page.unroute('**/goal_completions/');
    await page.reload();
    await openPractice(page);
    const history = await page.request.get(
      `${backendUrl()}/practice-sessions/?user_practice_id=${row.id}`,
      { headers: bearer(token) },
    );
    expect(history.ok()).toBe(true);
    expect((await history.json()) as unknown[]).toHaveLength(4);
    expect(units(await readHabit(page, token, habit.id))).toBe(12);
  });
}
