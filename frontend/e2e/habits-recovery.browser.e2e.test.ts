import { expect, test } from '@playwright/test';

import { completionsOf, isCompletionPost, readHabit } from './dayBoundaryBrowserSupport';
import {
  backendUrl,
  bearer,
  dayKeyIn,
  openHabits,
  openJournal,
  previousDayKey,
  seedHabit,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';

const QUEUE_BASE = '@adepthood/pending_checkins';
const DROPPED_BASE = '@adepthood/dropped_checkins';
const OWNER_KEY = '@adepthood/device_owner';

for (const timezone of ['UTC', 'America/Los_Angeles']) {
  test.describe(`offline resumed calendar recovery (${timezone})`, () => {
    test.use({ timezoneId: timezone });
    test('a later Habits load recovers the calendar and replays one legacy tap on its own day', async ({
      page,
      request,
    }, info) => {
      await page.clock.install();
      const email = await signUp(page, 'offline-calendar-recovery');
      const session = await sessionFor(request, email);
      expect(session.timezone).toBe(timezone);
      const habitId = await seedHabit(
        request,
        session.token,
        'Recovered offline walk',
        undefined,
        true,
      );
      const habit = await readHabit(request, session.token, habitId);
      const timestamp = `${previousDayKey(dayKeyIn(new Date().toISOString(), 'UTC'))}T01:00:00Z`;
      const localDay = dayKeyIn(timestamp, timezone);
      await page.evaluate(
        ({ goalId, timestamp, base, ownerKey }) => {
          const owner = localStorage.getItem(ownerKey);
          localStorage.setItem(
            `${base}#u${owner}`,
            JSON.stringify([{ goal_id: goalId, did_complete: true, timestamp }]),
          );
          localStorage.removeItem('@adepthood/user_timezone');
        },
        { goalId: habit.goals[0]!.id, timestamp, base: QUEUE_BASE, ownerKey: OWNER_KEY },
      );
      let offline = true;
      let refreshAttempts = 0;
      let completionPosts = 0;
      page.on('request', (sent) => {
        if (isCompletionPost(sent)) completionPosts += 1;
      });
      await page.route('**/auth/refresh', async (route) => {
        refreshAttempts += 1;
        await (offline ? route.abort('internetdisconnected') : route.fallback());
      });
      await page.reload();
      await expect(page.getByTestId('journal-habits-tile')).toBeVisible();
      await expect.poll(() => refreshAttempts).toBe(1);
      expect(completionPosts).toBe(0);
      expect(completionsOf(await readHabit(request, session.token, habitId))).toEqual([]);
      // Connectivity returns after the auth endpoint's cooldown. No refresh timer fires.
      offline = false;
      await page.clock.fastForward(61_000);
      expect(refreshAttempts).toBe(1);
      await openHabits(page);
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem('@adepthood/user_timezone')))
        .toBe(timezone);
      await expect
        .poll(async () =>
          completionsOf(await readHabit(request, session.token, habitId)).map(
            (entry) => entry.local_day,
          ),
        )
        .toEqual([localDay]);
      await expect.poll(() => completionPosts).toBe(1);
      await page.waitForTimeout(750);
      expect(refreshAttempts).toBe(2);
      expect(completionPosts).toBe(1);
      const tile = page.getByTestId('habit-tile').filter({ hasText: 'Recovered offline walk' });
      await expect(tile).toBeVisible();
      await page.screenshot({ path: info.outputPath('recovered-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(tile).toBeVisible();
      await page.screenshot({ path: info.outputPath('recovered-phone.png') });
    });
  });
}

test('a real rejected legacy tap keeps one visible loss after cleanup failure and retry', async ({
  page,
  request,
}, info) => {
  const email = await signUp(page, 'legacy-quarantine-retry');
  const session = await sessionFor(request, email);
  const habitId = await seedHabit(request, session.token, 'Deleted legacy walk', undefined, true);
  const habit = await readHabit(request, session.token, habitId);
  const removed = await request.delete(`${backendUrl()}/habits/${habitId}`, {
    headers: bearer(session.token),
  });
  expect(removed.ok()).toBe(true);
  await seedHabit(request, session.token, 'Kept recovery walk', undefined, true);
  await page.evaluate(
    ({ goalId, queueBase, droppedBase, ownerKey }) => {
      const owner = localStorage.getItem(ownerKey);
      const queueKey = `${queueBase}#u${owner}`;
      const droppedKey = `${droppedBase}#u${owner}`;
      localStorage.setItem(
        queueKey,
        JSON.stringify([
          { goal_id: goalId, did_complete: true, timestamp: new Date().toISOString() },
        ]),
      );
      const read = Storage.prototype.getItem;
      let failed = false;
      // Inject a real device-storage read failure only after the loss is durable.
      Storage.prototype.getItem = function (key: string) {
        if (key === queueKey && !failed && read.call(this, droppedKey)?.includes('replay_id')) {
          failed = true;
          throw new Error('temporary pending cleanup read failure');
        }
        return read.call(this, key);
      };
    },
    {
      goalId: habit.goals[0]!.id,
      queueBase: QUEUE_BASE,
      droppedBase: DROPPED_BASE,
      ownerKey: OWNER_KEY,
    },
  );
  const posts: Record<string, unknown>[] = [];
  page.on('request', (sent) => {
    if (isCompletionPost(sent)) posts.push(sent.postDataJSON() as Record<string, unknown>);
  });
  await openHabits(page);
  const notice = page.getByTestId('dropped-check-in-notice');
  await expect(notice).toContainText('1 offline check-in could not be saved.');
  await expect
    .poll(() =>
      page.evaluate(
        ({ base, ownerKey }) => {
          const owner = localStorage.getItem(ownerKey);
          return JSON.parse(localStorage.getItem(`${base}#u${owner}`) ?? '[]') as unknown[];
        },
        { base: QUEUE_BASE, ownerKey: OWNER_KEY },
      ),
    )
    .toHaveLength(1);
  await openJournal(page);
  await openHabits(page);
  await expect.poll(() => posts.length).toBe(2);
  await expect(notice).toContainText('1 offline check-in could not be saved.');
  expect(posts.every((body) => !('replay_id' in body) && !('operation_id' in body))).toBe(true);
  await page.screenshot({ path: info.outputPath('legacy-loss-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice).toBeVisible();
  await page.screenshot({ path: info.outputPath('legacy-loss-phone.png') });
});
