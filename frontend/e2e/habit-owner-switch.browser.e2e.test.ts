import { expect, test, type Page } from '@playwright/test';

import { completionsOf, readHabit } from './dayBoundaryBrowserSupport';
import {
  backendUrl,
  bearer,
  logInInPlace,
  seedHabit,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';

// A routed read can still be awaiting `route.fetch()` when the test ends, and
// that fetch then rejects with "Test ended" outside any test (#3481). Unroute
// first so a straggler's late error is dropped rather than failing the run.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const OUTGOING = 'Outgoing account sitting';
const INCOMING = 'Incoming account walk';
const CURRENT_CREATE = 'Incoming account evening walk';

for (const width of [390, 1280]) {
  test(`a captured current-session check-in renews after a 401 at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const name = 'Current account renewed sitting';
    const email = await signUp(page, 'captured-check-in-renewal');
    const session = await sessionFor(page.request, email);
    const habitId = await seedHabit(page.request, session.token, name, '2026-01-01', true);
    await page.reload();
    await openHabits(page);
    const tile = page.getByTestId('habit-tile').filter({ hasText: name });
    await expect(tile).toBeVisible();

    const credentials: string[] = [];
    const bodies: string[] = [];
    let renewedToken = '';
    await page.route('**/auth/refresh', async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      renewedToken = ((await response.json()) as { token: string }).token;
      await route.fulfill({ response });
    });
    await page.route('**/goal_completions/**', async (route) => {
      if (route.request().method() === 'POST') {
        credentials.push(route.request().headers().authorization ?? '');
        bodies.push(route.request().postData() ?? '');
        if (credentials.length === 1) {
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: '{"detail":"session_expired"}',
          });
        } else {
          await route.continue();
        }
      } else {
        await route.continue();
      }
    });

    await tile.click();
    await page.getByRole('button', { name: 'Log Units' }).click();
    await expect.poll(() => credentials.length).toBe(2);
    expect(renewedToken).not.toBe('');
    expect(credentials[0]).not.toBe(`Bearer ${renewedToken}`);
    expect(credentials[1]).toBe(`Bearer ${renewedToken}`);
    expect(bodies[1]).toBe(bodies[0]);
    await expect
      .poll(async () => completionsOf(await readHabit(page.request, session.token, habitId)).length)
      .toBe(1);
    await page.getByTestId('goal-modal-backdrop').click({ position: { x: 4, y: 4 } });
    await expect(page.getByTestId('goal-modal-backdrop')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('habits-list')).toBeVisible();
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('1-DAY RUN');
    await page.screenshot({
      path: testInfo.outputPath('current-account-after-captured-renewal.png'),
      fullPage: true,
    });
  });
}

async function openHabits(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Habits', exact: true }).click();
  await expect(page.getByTestId('habits-list')).toBeVisible();
}

async function addHabit(page: Page, name: string, awaitClose = true): Promise<void> {
  await page.getByRole('button', { name: 'Open Habits menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add Habit', exact: true }).click();
  const sheet = page.getByTestId('add-habit-modal');
  await sheet.getByTestId('add-habit-name').fill(name);
  await sheet.getByTestId('add-habit-save').click();
  if (awaitClose) await expect(sheet).toHaveCount(0);
}

for (const width of [390, 1280]) {
  test(`a held create cannot replace the next account's habits at ${width}px`, async ({
    browser,
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    const incomingEmail = await signUp(otherPage, 'habit-owner-incoming');
    const incoming = await sessionFor(otherPage.request, incomingEmail);
    await seedHabit(otherPage.request, incoming.token, INCOMING, '2026-01-01');
    await otherContext.close();
    const outgoingEmail = await signUp(page, 'habit-owner-outgoing');
    const outgoing = await sessionFor(page.request, outgoingEmail);
    await seedHabit(page.request, outgoing.token, OUTGOING, '2026-01-01');
    await page.reload();
    await openHabits(page);
    await expect(page.getByTestId('habit-tile').filter({ hasText: OUTGOING })).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.ownerWitness = 'same-running-app';
    });

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let created!: () => void;
    const serverCreated = new Promise<void>((resolve) => {
      created = resolve;
    });
    let oldId = 0;
    const followOns: string[] = [];
    page.on('request', (request) => {
      if (
        oldId > 0 &&
        ['PUT', 'DELETE'].includes(request.method()) &&
        new URL(request.url()).pathname.startsWith('/habits/')
      )
        followOns.push(request.method());
    });
    await page.route('**/habits/', async (route) => {
      if (
        route.request().method() !== 'POST' ||
        route.request().postDataJSON().name !== 'Held outgoing create'
      ) {
        await route.continue();
      } else {
        // The real A POST lands; only delivery of its answer is controlled.
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        oldId = ((await response.json()) as { id: number }).id;
        created();
        await hold;
        if (width === 390)
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"detail":"Controlled lost create reply"}',
          });
        else await route.fulfill({ response });
      }
    });
    await addHabit(page, 'Held outgoing create', false);
    await serverCreated;
    await page.getByTestId('add-habit-close').click();
    await expect(page.getByTestId('add-habit-modal')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open settings' }).filter({ visible: true }).click();
    await page.getByTestId('settings-row-logout').click();
    await page.getByRole('link', { name: 'Go to log-in screen' }).click();
    await logInInPlace(page, incomingEmail);
    await expect(page.locator('html')).toHaveAttribute('data-owner-witness', 'same-running-app');
    await openHabits(page);
    await expect(page.getByTestId('habit-tile').filter({ hasText: INCOMING })).toBeVisible();
    const oldResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.name === 'Held outgoing create',
    );
    release();
    await (await oldResponse).finished();

    // Observe the delivered old response before any B mutation can mask a
    // transient rollback or old-account confirmation with another refresh.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(page.getByTestId('habit-tile').filter({ hasText: INCOMING })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: OUTGOING })).toHaveCount(0);
    await expect(
      page.getByTestId('habit-tile').filter({ hasText: 'Held outgoing create' }),
    ).toHaveCount(0);
    expect(followOns).toEqual([]);

    // The incoming app also remains usable without a reload.
    const currentConfirmed = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' && new URL(response.url()).pathname === '/habits/',
    );
    await addHabit(page, CURRENT_CREATE);
    await currentConfirmed;
    await expect(page.getByTestId('habit-tile').filter({ hasText: CURRENT_CREATE })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: INCOMING })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: OUTGOING })).toHaveCount(0);
    expect(followOns).toEqual([]);
    const listed = await page.request.get(`${backendUrl()}/habits/`, {
      headers: bearer(incoming.token),
    });
    expect(listed.ok()).toBe(true);
    expect(((await listed.json()) as { name: string }[]).map((row) => row.name)).toEqual(
      expect.arrayContaining([INCOMING, CURRENT_CREATE]),
    );
    await page.screenshot({
      path: testInfo.outputPath('incoming-account-after-held-create.png'),
      fullPage: true,
    });
    await page.reload();
    // Reload retains the real Habits URL; no Journal drawer transition occurs.
    await expect(page.getByTestId('habits-list')).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: INCOMING })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: CURRENT_CREATE })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: OUTGOING })).toHaveCount(0);
  });
}

for (const width of [390, 1280]) {
  test(`a held refresh cannot hydrate the next account's habits at ${width}px`, async ({
    browser,
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    const incomingEmail = await signUp(otherPage, 'habit-refresh-incoming');
    const incoming = await sessionFor(otherPage.request, incomingEmail);
    await seedHabit(otherPage.request, incoming.token, INCOMING, '2026-01-01');
    await otherContext.close();
    const outgoingEmail = await signUp(page, 'habit-refresh-outgoing');
    const outgoing = await sessionFor(page.request, outgoingEmail);
    await seedHabit(page.request, outgoing.token, OUTGOING, '2026-01-01');
    await page.reload();
    await openHabits(page);
    await expect(page.getByTestId('habit-tile').filter({ hasText: OUTGOING })).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetched!: () => void;
    const serverRead = new Promise<void>((resolve) => {
      fetched = resolve;
    });
    let holding = false;
    let heldCredential = '';
    await page.route(
      (url) => url.pathname === '/habits/',
      async (route) => {
        if (holding || route.request().method() !== 'GET') {
          await route.continue();
        } else {
          holding = true;
          heldCredential = route.request().headers().authorization ?? '';
          expect(heldCredential).toMatch(/^Bearer /);
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          const payload = (await response.json()) as { items: { name: string }[] };
          expect(payload.items.map((row) => row.name)).toContain(OUTGOING);
          fetched();
          await held;
          await route.fulfill({ response });
        }
      },
    );
    await page.reload();
    await page.evaluate(() => {
      document.documentElement.dataset.refreshWitness = 'same-running-app';
    });
    // The reload retains the Habits URL; its real cache keeps the page usable
    // while the next authoritative refresh answer is held.
    await expect(page.getByTestId('habits-list')).toBeVisible();
    await serverRead;
    await page.getByRole('button', { name: 'Open settings' }).filter({ visible: true }).click();
    await page.getByTestId('settings-row-logout').click();
    await page.getByRole('link', { name: 'Go to log-in screen' }).click();
    await logInInPlace(page, incomingEmail);
    await expect(page.locator('html')).toHaveAttribute('data-refresh-witness', 'same-running-app');
    await openHabits(page);
    await expect(page.getByTestId('habit-tile').filter({ hasText: INCOMING })).toBeVisible();
    const delivered = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/habits/' &&
        response.request().headers().authorization === heldCredential,
    );
    release();
    await (await delivered).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    // Assert before B's own successful create/confirmation could cover a stale A hydration.
    await expect(page.getByTestId('habit-tile').filter({ hasText: INCOMING })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: OUTGOING })).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('incoming-account-after-held-refresh.png'),
      fullPage: true,
    });
    await addHabit(page, CURRENT_CREATE);
    await expect(page.getByTestId('habit-tile').filter({ hasText: CURRENT_CREATE })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('habits-list')).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: INCOMING })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: CURRENT_CREATE })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: OUTGOING })).toHaveCount(0);
  });
}
