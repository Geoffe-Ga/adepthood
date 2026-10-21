import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  ARTIFACTS,
  expectTextWithinViewport,
  seedInvitations,
} from './declineOwnershipBrowserSupport';
import { backendUrl, bearer, sessionFor, signUp, openPrompts } from './journalHabitsBrowserSupport';

for (const width of [390, 1280]) {
  test(`real invitation decline selectively restores one failed row and retries at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, 'invitation-decline');
    const { token } = await sessionFor(page.request, email);
    const ids = seedInvitations(email);
    const [first, second, third] = ids;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error('Missing seeded invitation');
    const listed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/invitations' &&
        response.request().method() === 'GET',
    );
    await page.reload();
    await openPrompts(page);
    expect((await listed).status()).toBe(200);
    for (const id of ids) await expect(page.getByTestId(`invitation-${id}`)).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refusedAttempts = 0;
    await page.route(`**/invitations/${first}/dismiss`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      refusedAttempts += 1;
      await held;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': new URL(page.url()).origin },
        body: '{"detail":"temporary_failure"}',
      });
    });
    await page.getByTestId(`invitation-${first}-dismiss`).click();
    await expect(page.getByTestId(`invitation-${first}`)).toHaveCount(0);
    const dismissed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/invitations/${second}/dismiss`,
    );
    await page.getByTestId(`invitation-${second}-dismiss`).click();
    expect((await dismissed).status()).toBe(200);
    const failed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/invitations/${first}/dismiss`,
    );
    release();
    expect((await failed).status()).toBe(503);
    await expect(page.getByTestId(`invitation-${first}`)).toBeVisible();
    await expect(page.getByTestId(`invitation-${second}`)).toHaveCount(0);
    await expect(page.getByTestId(`invitation-${third}`)).toBeVisible();
    // The transport's normal idempotent retry also failed. Only now does the
    // hook have a terminal failure to restore, and the user can explicitly retry.
    expect(refusedAttempts).toBeGreaterThan(1);
    await page.unroute(`**/invitations/${first}/dismiss`);
    const server = await page.request.get(`${backendUrl()}/invitations`, {
      headers: bearer(token),
    });
    expect(((await server.json()) as Array<{ id: number }>).map((row) => row.id)).toEqual([
      first,
      third,
    ]);
    await page.getByTestId(`invitation-${first}`).evaluate((root) => {
      for (const element of root.querySelectorAll<HTMLElement>('*')) {
        if (element.childElementCount || !element.textContent?.trim()) continue;
        const style = getComputedStyle(element);
        element.style.fontSize = `${parseFloat(style.fontSize) * 2}px`;
        element.style.lineHeight = `${parseFloat(style.lineHeight) * 2}px`;
      }
    });
    const retry = page.getByTestId(`invitation-${first}-dismiss`);
    await retry.scrollIntoViewIfNeeded();
    await retry.focus();
    await expect(retry).toBeFocused();
    await expectTextWithinViewport(page, `invitation-${first}`);
    const hit = await retry.boundingBox();
    expect(hit?.width).toBeGreaterThanOrEqual(44);
    expect(hit?.height).toBeGreaterThanOrEqual(44);
    mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: join(ARTIFACTS, `invitation-retry-${width}-200.png`) });
    const retried = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/invitations/${first}/dismiss`,
    );
    await page.keyboard.press('Enter');
    expect((await retried).status()).toBe(200);
    await page.reload();
    await expect(page.getByTestId(`invitation-${third}`)).toBeVisible();
    await expect(page.getByTestId(`invitation-${first}`)).toHaveCount(0);
    await expect(page.getByTestId(`invitation-${second}`)).toHaveCount(0);
  });
}
