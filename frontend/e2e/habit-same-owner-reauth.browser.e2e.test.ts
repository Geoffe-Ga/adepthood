import { expect, test, type Page, type Route } from '@playwright/test';

import {
  backendUrl,
  openHabits,
  reauthenticateInPlace,
  seedHabit,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';

/**
 * #3326: a Habit create captured by a session that a 401 ended must not act
 * on the session the SAME account signs back into. The account id never
 * changes across this reauthentication, so only the session boundary can tell
 * the old create's late answer from the new session's own work.
 *
 * The 401 is real: the held create's own credential is rotated away on the
 * real server, so the app's next authenticated read is refused, its refresh of
 * that revoked token is refused, and the running app raises the re-auth sheet.
 */
const SEEDED = 'Reauth account seeded sitting';
const HELD = 'Held create across reauthentication';

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

for (const width of [390, 1280]) {
  const outcome = width === 390 ? 'failure' : 'success';
  test(`a held create's late ${outcome} cannot act on a same-owner reauthentication at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const email = await signUp(page, `habit-reauth-${outcome}`);
    const session = await sessionFor(page.request, email);
    await seedHabit(page.request, session.token, SEEDED, '2026-01-01');
    await page.reload();
    await openHabits(page);
    await expect(page.getByTestId('habit-tile').filter({ hasText: SEEDED })).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.reauthWitness = 'same-running-app';
    });
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let created!: () => void;
    const serverCreated = new Promise<void>((resolve) => {
      created = resolve;
    });
    let heldCredential = '';
    const followOns: string[] = [];
    let released = false;
    // Anything the ended session still sends once its create is answered is a
    // continuation of that session: a sibling PUT, a compensating DELETE, or
    // the confirmation read that would re-hydrate the list.
    page.on('request', (request) => {
      if (released && request.headers().authorization === heldCredential)
        followOns.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    const holdHeldCreate = async (route: Route): Promise<void> => {
      heldCredential = route.request().headers().authorization ?? '';
      // The real create lands; only delivery of its answer is held.
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      created();
      await hold;
      if (outcome === 'failure')
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"detail":"Controlled lost create reply"}',
        });
      else await route.fulfill({ response });
    };
    await page.route('**/habits/', async (route) => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().name === HELD)
        await holdHeldCreate(route);
      else await route.continue();
    });

    await page.getByRole('button', { name: 'Open Habits menu' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Add Habit', exact: true }).click();
    const sheet = page.getByTestId('add-habit-modal');
    await sheet.getByTestId('add-habit-name').fill(HELD);
    await sheet.getByTestId('add-habit-save').click();
    await serverCreated;
    await page.getByTestId('add-habit-close').click();
    await expect(sheet).toHaveCount(0);

    // End the held create's session for real: rotating its token revokes it.
    const rotated = await page.request.post(`${backendUrl()}/auth/refresh`, {
      headers: { authorization: heldCredential },
    });
    expect(rotated.ok()).toBe(true);
    // The journal's next read carries the revoked token: a real 401 whose
    // refresh is refused too, so the running app asks the same account back in.
    await page.getByRole('button', { name: 'Open Habits menu' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Journal', exact: true }).click();
    await reauthenticateInPlace(page, email);
    await expect(page.locator('html')).toHaveAttribute('data-reauth-witness', 'same-running-app');

    // Returning to Habits hydrates the account's real rows, the held create included.
    await openHabits(page);
    await expect(page.getByTestId('habit-tile').filter({ hasText: SEEDED })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: HELD })).toBeVisible();

    const oldResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.request().postDataJSON()?.name === HELD,
    );
    // Retrying locators would wait out a transient rollback, so watch every
    // DOM change from the release onward for a frame without the row.
    await page.evaluate((name) => {
      const witness = window as unknown as { heldRowVanished?: boolean };
      witness.heldRowVanished = false;
      const check = (): void => {
        const tiles = [...document.querySelectorAll('[data-testid="habit-tile"]')];
        if (!tiles.some((tile) => tile.textContent?.includes(name))) witness.heldRowVanished = true;
      };
      new MutationObserver(check).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }, HELD);
    released = true;
    release();
    await (await oldResponse).finished();
    await settleFrames(page);
    // Let any late continuation of the old session (rollback, confirmation
    // read, follow-on write) run to completion before judging it.
    await page.waitForLoadState('networkidle');
    await settleFrames(page);
    expect(
      await page.evaluate(
        () => (window as unknown as { heldRowVanished?: boolean }).heldRowVanished,
      ),
    ).toBe(false);

    await expect(page.getByTestId('habit-tile').filter({ hasText: SEEDED })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: HELD })).toHaveCount(1);
    await expect(page.getByText("Couldn't sync")).toHaveCount(0);
    expect(dialogs).toEqual([]);
    expect(followOns).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`same-owner-after-held-create-${outcome}.png`),
      fullPage: true,
    });

    // A cold start of the new session shows the same rows: one held create, no duplicate.
    await page.reload();
    await expect(page.getByTestId('habits-list')).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: SEEDED })).toBeVisible();
    await expect(page.getByTestId('habit-tile').filter({ hasText: HELD })).toHaveCount(1);
  });
}
