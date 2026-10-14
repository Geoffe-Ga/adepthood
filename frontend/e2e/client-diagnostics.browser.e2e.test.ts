import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type ConsoleMessage } from '@playwright/test';

import { backendUrl, openHabits, seedHabit, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * #3210: private prose in an API failure stays out of every console argument,
 * while the visible Retry control still recovers through the real authenticated
 * backend. Only the failed response is intercepted; the recovery and fixture
 * read both reach the lane's migrated PostgreSQL database.
 */
const CANARIES = [
  'SYNTHETIC_SHORT_PRIVATE',
  `SYNTHETIC_LONG_PRIVATE_${'x'.repeat(600)}`,
  'SYNTHETIC_UNICODE_PRIVATE_u\u0308_日本語',
  'SYNTHETIC_MULTILINE_PRIVATE\nprivate second line',
  'SYNTHETIC_RTL_PRIVATE שלום مرحبا',
  'SYNTHETIC_EMOJI_PRIVATE 🕯️🧡',
];
const HABIT_NAME = 'Diagnostic recovery habit';
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
];

/** Inspect all arguments, including Error's non-enumerable message/stack/cause. */
async function consoleArguments(message: ConsoleMessage): Promise<string[]> {
  return Promise.all(
    message.args().map((argument) =>
      argument.evaluate((value: unknown) => {
        const seen = new Set<unknown>();
        const strings: string[] = [];
        const visit = (input: unknown, depth: number): void => {
          if (typeof input === 'string') {
            strings.push(input);
          } else if (input !== null && typeof input === 'object' && !seen.has(input)) {
            if (depth > 8) throw new Error('console argument exceeded inspection depth');
            seen.add(input);
            for (const [key, descriptor] of Object.entries(
              Object.getOwnPropertyDescriptors(input),
            )) {
              strings.push(key);
              if ('value' in descriptor) visit(descriptor.value, depth + 1);
            }
          }
        };
        visit(value, 0);
        return strings.join('\n');
      }),
    ),
  );
}

for (const viewport of VIEWPORTS) {
  for (const failure of ['invalid_response', 'server_error'] as const) {
    test(`${viewport.width}px ${failure}: fixed diagnostics and visible recovery`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const email = await signUp(page, `diagnostics-${viewport.width}-${failure}`);
      const token = await tokenFor(page.request, email);
      const habitId = await seedHabit(page.request, token, HABIT_NAME, undefined, true);
      const consoleRecords: Array<Promise<string[]>> = [];
      page.on('console', (message) => {
        consoleRecords.push(consoleArguments(message));
      });
      let intercepted = 0;
      await page.route(/\/habits\/(?:\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
        } else {
          intercepted += 1;
          await route.fulfill({
            status: failure === 'invalid_response' ? 200 : 500,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(
              failure === 'invalid_response'
                ? {
                    items: [
                      { id: CANARIES.join(' '), name: CANARIES.join(' '), private: CANARIES },
                    ],
                    next_cursor: null,
                  }
                : { detail: CANARIES.join(' '), nested: { private: CANARIES } },
            ),
          });
        }
      });

      await openHabits(page);
      const errorBanner = page.getByTestId('habits-error-banner');
      await expect(errorBanner).toBeVisible();
      const retry = page.getByTestId('retry-button');
      await expect(retry).toBeVisible();
      const bounds = await retry.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      expect(intercepted).toBeGreaterThan(0);

      const artifactDir = join(
        __dirname,
        'artifacts',
        'client-diagnostics',
        String(viewport.width),
      );
      mkdirSync(artifactDir, { recursive: true });
      await page.screenshot({ path: join(artifactDir, `${failure}-error.png`) });
      await page.unrouteAll({ behavior: 'wait' });
      const recovered = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/habits/' &&
          response.request().method() === 'GET' &&
          response.status() === 200,
      );
      await retry.click();
      const successfulRead = await recovered;
      expect(successfulRead.request().headers()['authorization']).toMatch(/^Bearer \S+$/);
      expect(((await successfulRead.json()) as { items: Array<{ id: number }> }).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: habitId, name: HABIT_NAME })]),
      );
      await expect(errorBanner).toHaveCount(0);
      await expect(page.getByTestId('habit-tile').filter({ hasText: HABIT_NAME })).toBeVisible();
      await page.screenshot({ path: join(artifactDir, `${failure}-recovered.png`) });

      // Independent authenticated HTTP read proves the displayed row really
      // exists in the database; no fabricated successful response is involved.
      const persisted = await page.request.get(`${backendUrl()}/habits/${habitId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(persisted.ok()).toBe(true);
      expect(await persisted.json()).toMatchObject({ id: habitId, name: HABIT_NAME });
      const records = (await Promise.all(consoleRecords)).flat();
      const diagnostic =
        failure === 'invalid_response' ? 'api_response_invalid' : 'api_server_error';
      expect(records).toContain(diagnostic);
      for (const record of records) {
        for (const canary of CANARIES) {
          expect(record).not.toContain(canary.split('\n')[0]);
          expect(record).not.toContain(JSON.stringify(canary).slice(1, -1));
        }
      }
    });
  }
}
