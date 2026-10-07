import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Response,
  type Route,
} from '@playwright/test';

import { completionsOf, isCompletionPost, readHabit } from './dayBoundaryBrowserSupport';
import {
  backendUrl,
  bearer,
  dayKeyIn,
  frontendUrl,
  goOffline,
  goOnline,
  openHabits,
  openJournal,
  previousDayKey,
  seedHabit,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';
import { instantAt } from './zonedClock';

/**
 * #2474 / #2473: a check-in tapped while the device is offline is queued on
 * the device, and the next habits load replays that queue against the real
 * server.
 *
 * The device goes offline for real (`setOffline`, waited on through the app's
 * own offline banner), the queue is read straight out of the device's storage,
 * and every claim about what landed is read back from the server out of band
 * with a standalone request context the page's connectivity never touches.
 *
 * Reconnecting does not replay the habit queue by itself (unlike the journal's
 * reconnect load, #2935) -- a habits load does. Every replay here is triggered
 * the same way: load the app afresh online onto the journal shelf, whose mount
 * load is the one drain, wait there until the queue reaches its expected end
 * state, and only then open Habits. Opening Habits straight after the load
 * would start a second drain while the first was still posting.
 *
 * The page clock is installed before sign-up and pinned to a fixed wall time on
 * the day under test in the account's zone, so the day a tap is queued on, the
 * day it replays on, and the retry record's age are never the host's clock.
 */

const USER_TIMEZONE = 'America/Los_Angeles';
/** Midday: as far as the pinned clock can be from either of the account's midnights. */
const PINNED_WALL = '12:00';
const OFFLINE_TOAST =
  "You're offline — check-in saved on this device. It will sync when you reconnect.";
const DROPPED_ONE = '1 offline check-in could not be saved.';
const DISMISS_LABEL = 'Dismiss';
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;

/** How many taps a drain test queues; more than one so order and exactly-once both show. */
const QUEUED_TAPS = 3;
/** The queue index whose replay the transient test fails, so a posted prefix precedes it. */
const ABORTED_INDEX = 1;

/** Unscoped stamp of whose caches this device holds (`userScope.DEVICE_OWNER_KEY`). */
const DEVICE_OWNER_KEY = '@adepthood/device_owner';
/** `habitStorage.PENDING_CHECKINS_KEY_BASE`, scoped per account with `#u<id>`. */
const PENDING_KEY_BASE = '@adepthood/pending_checkins';
/** `habitStorage.DROPPED_CHECKINS_KEY_BASE`: the on-device quarantine. */
const DROPPED_KEY_BASE = '@adepthood/dropped_checkins';
/** `checkInReplayState`'s base key: the queue head's retry record (#2473). */
const REPLAY_STATE_KEY_BASE = '@adepthood/pending_checkin_replay_state';
/** `userScope.SCOPE_MARKER`. */
const SCOPE_MARKER = '#u';

/** Mirrors `replayPolicy.MAX_CHECK_IN_REPLAY_ATTEMPTS`. */
const MAX_CHECK_IN_REPLAY_ATTEMPTS = 5;
const MS_PER_DAY = 86_400_000;
/** One day past `replayPolicy.MIN_POISON_AGE_MS` (seven days). */
const AGE_PAST_POISON_FLOOR_MS = 8 * MS_PER_DAY;

/**
 * How long a response log must hold still before its count is believed. An
 * exact count is the point -- one POST per queued check-in, not one-or-more --
 * so the log is polled up to its target and then watched for a quiet window,
 * inside which a duplicate post would land (the same rule `requestTally` uses).
 */
const SETTLE_MS = 750;

test.use({ timezoneId: USER_TIMEZONE });

/** A queued check-in as the device stores it (`habitStorage.PendingCheckIn`). */
interface QueuedCheckIn {
  goal_id: number;
  did_complete: boolean;
  completed_units?: number;
  operation_id?: string;
  timestamp: string;
  completed_on?: string;
}

/** The wire key a replay sends for a queued entry (`habitManager.logUnitIdempotencyKey`). */
function replayKey(operationId: string): string {
  return `log-unit:${operationId}`;
}

/** Every operation id in a queue; a queued tap always carries one. */
function operationIds(queue: QueuedCheckIn[]): string[] {
  return queue.map((entry) => {
    if (entry.operation_id === undefined) throw new Error('a queued tap carried no operation id');
    return entry.operation_id;
  });
}

/** Read one of this account's scoped device keys, as JSON, or null when absent. */
async function readScoped(page: Page, base: string): Promise<unknown> {
  return page.evaluate(
    ({ ownerKey, keyBase, marker }) => {
      const owner = localStorage.getItem(ownerKey);
      if (owner === null) throw new Error('the device has no owner stamp');
      const raw = localStorage.getItem(`${keyBase}${marker}${owner}`);
      return raw === null ? null : (JSON.parse(raw) as unknown);
    },
    { ownerKey: DEVICE_OWNER_KEY, keyBase: base, marker: SCOPE_MARKER },
  );
}

async function readPendingQueue(page: Page): Promise<QueuedCheckIn[] | null> {
  return (await readScoped(page, PENDING_KEY_BASE)) as QueuedCheckIn[] | null;
}

/** The queue's operation ids, or null once the queue key is gone. */
async function queuedIds(page: Page): Promise<string[] | null> {
  const queue = await readPendingQueue(page);
  return queue === null ? null : operationIds(queue);
}

interface PostedCompletion {
  status: number;
  /** A 2xx: the server stored it. */
  ok: boolean;
  key: string | null;
  body: QueuedCheckIn & { completed_on?: string };
}

interface CompletionLog {
  mark: () => void;
  sinceMark: () => PostedCompletion[];
  /** Exactly `count` responses since the mark, and no more after a quiet window. */
  settleAt: (count: number, because: string) => Promise<PostedCompletion[]>;
  /** The same, counting only responses carrying idempotency key `key`. */
  settleOnKey: (key: string, count: number, because: string) => Promise<PostedCompletion[]>;
}

/** Record every POST /goal_completions/ the SERVER answered: a failed fetch has no response. */
function completionLog(page: Page): CompletionLog {
  const seen: PostedCompletion[] = [];
  let marked = 0;
  page.on('response', (response: Response) => {
    const request = response.request();
    if (!isCompletionPost(request)) return;
    seen.push({
      status: response.status(),
      ok: response.ok(),
      key: request.headers()['idempotency-key'] ?? null,
      body: request.postDataJSON() as PostedCompletion['body'],
    });
  });
  const sinceMark = (): PostedCompletion[] => seen.slice(marked);
  const settle = async (
    matching: () => PostedCompletion[],
    count: number,
    because: string,
  ): Promise<PostedCompletion[]> => {
    await expect.poll(() => matching().length, { message: because }).toBeGreaterThanOrEqual(count);
    await page.waitForTimeout(SETTLE_MS);
    expect(matching().length, because).toBe(count);
    return matching();
  };
  return {
    mark: () => {
      marked = seen.length;
    },
    sinceMark,
    settleAt: (count, because) => settle(sinceMark, count, because),
    settleOnKey: (key, count, because) =>
      settle(() => sinceMark().filter((post) => post.key === key), count, because),
  };
}

/**
 * Replay through exactly one drain: load the app afresh, online, onto the
 * journal shelf, whose mount load drains the queue, and wait there until the
 * queue reaches `expectEnd` -- gone (`null`) after a full drain, or the ids of
 * the suffix a failure kept. A plain reload would not do: the taps were made on
 * Habits, and the web URL would bring the app back up there.
 */
async function replayFromShelf(page: Page, expectEnd: string[] | null): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await expect(page.getByTestId('journal-habits-tile')).toBeVisible();
  await expect.poll(() => queuedIds(page)).toEqual(expectEnd);
}

function tile(page: Page, name: string) {
  return page.getByTestId('habit-tile').filter({ hasText: name });
}

/** Close the goal sheet by its backdrop, tapped clear of the sheet itself. */
const BACKDROP_CORNER = { x: 4, y: 4 };

/** Log one unit `taps` times on a habit through its goal sheet. */
async function logUnits(page: Page, name: string, taps: number): Promise<void> {
  await tile(page, name).click();
  for (let tap = 0; tap < taps; tap += 1) {
    await page.getByRole('button', { name: 'Log Units' }).click();
  }
  const backdrop = page.getByTestId('goal-modal-backdrop');
  await backdrop.click({ position: BACKDROP_CORNER });
  await expect(backdrop).toHaveCount(0);
}

/** Units the server holds for a habit, across every tier and day. */
async function serverUnits(
  request: APIRequestContext,
  token: string,
  habitId: number,
): Promise<number> {
  return completionsOf(await readHabit(request, token, habitId)).reduce(
    (total, completion) => total + completion.completed_units,
    0,
  );
}

/** The ids of a habit's goals, read from the server. */
async function goalIdsOf(
  request: APIRequestContext,
  token: string,
  habitId: number,
): Promise<number[]> {
  return (await readHabit(request, token, habitId)).goals.map((goal) => goal.id);
}

interface Arranged {
  token: string;
  /** The day the pinned page clock reads, in the account's zone. */
  pinnedDay: string;
  /** The server's today in the account's zone. */
  today: string;
  habitIds: number[];
}

/**
 * A fresh account with revealed habits, the page reloaded onto Habits with its
 * clock pinned to midday on `daysBack` days before the server's today.
 */
async function arrange(
  page: Page,
  request: APIRequestContext,
  prefix: string,
  names: string[],
  daysBack: 0 | 1 = 0,
): Promise<Arranged> {
  await page.clock.install();
  const email = await signUp(page, prefix);
  const { token, timezone } = await sessionFor(request, email);
  expect(timezone, 'the account did not take the browser zone').toBe(USER_TIMEZONE);
  const today = dayKeyIn(new Date().toISOString(), USER_TIMEZONE);
  const pinnedDay = daysBack === 0 ? today : previousDayKey(today);
  const habitIds: number[] = [];
  for (const name of names) {
    habitIds.push(await seedHabit(request, token, name, undefined, true));
  }
  await page.clock.setSystemTime(instantAt(pinnedDay, PINNED_WALL, USER_TIMEZONE));
  await page.reload();
  await openHabits(page);
  for (const name of names) await expect(tile(page, name)).toBeVisible();
  return { token, pinnedDay, today, habitIds };
}

/**
 * Go offline and tap, habit by habit, waiting after each habit until the device
 * holds its taps. Each tap is queued only once its offline POST has finished
 * failing, retries and all, so taps on two habits made back to back could land
 * in either order; waiting between habits makes the queue order the tap order.
 */
async function queueOffline(
  page: Page,
  taps: Array<[name: string, count: number]>,
): Promise<QueuedCheckIn[]> {
  await goOffline(page);
  let queued = 0;
  for (const [name, count] of taps) {
    await logUnits(page, name, count);
    queued += count;
    await expect.poll(async () => (await readPendingQueue(page))?.length ?? 0).toBe(queued);
  }
  // Identical toasts can stack while a retried offline POST fails, so `.first()`.
  await expect(page.getByText(OFFLINE_TOAST).first()).toBeVisible();
  const queue = await readPendingQueue(page);
  if (queue === null) throw new Error('the queue vanished while offline');
  return queue;
}

test('a check-in tapped offline is queued on the device and replays exactly once after reconnect', async ({
  page,
  request,
}) => {
  const HABIT = 'Offline walk';
  const { token, today, habitIds } = await arrange(page, request, 'offline-drain', [HABIT]);
  const [habitId] = habitIds as [number];
  const goalIds = await goalIdsOf(request, token, habitId);
  expect(completionsOf(await readHabit(request, token, habitId))).toEqual([]);

  const queue = await queueOffline(page, [[HABIT, QUEUED_TAPS]]);
  // The optimistic count stays on the tile while the taps wait on the device.
  await expect(tile(page, HABIT).getByTestId('progress-fill')).not.toHaveCSS('width', '0px');
  const ids = operationIds(queue);
  expect(new Set(ids).size, 'each tap needs its own operation id').toBe(QUEUED_TAPS);
  // Each tap names a goal of this habit -- whichever tier the tap landed on.
  for (const entry of queue) expect(goalIds).toContain(entry.goal_id);
  // Nothing reached the server while the device was offline.
  expect(completionsOf(await readHabit(request, token, habitId))).toEqual([]);

  const log = completionLog(page);
  await goOnline(page);
  log.mark();
  await replayFromShelf(page, null);

  const posted = await log.settleAt(QUEUED_TAPS, 'one replay POST per queued check-in');
  expect(posted.map((post) => post.key)).toEqual(ids.map(replayKey));
  for (const post of posted) {
    expect(post.ok, `replay answered ${post.status}`).toBe(true);
    // A same-day replay lets the server stamp the day, as an online tap does.
    expect(post.body.completed_on).toBeUndefined();
  }
  const completions = completionsOf(await readHabit(request, token, habitId));
  // One row per goal the taps landed on, every one of them on the day they were tapped.
  expect(completions.length).toBeGreaterThan(0);
  for (const completion of completions) expect(completion.local_day).toBe(today);
  expect(await serverUnits(request, token, habitId)).toBe(QUEUED_TAPS);

  // Opening Habits now runs its own load, and it finds nothing left to post.
  await openHabits(page);
  await log.settleAt(QUEUED_TAPS, 'the Habits load must not re-post a drained queue');
});

test('a queued check-in the server permanently rejects is dropped, the rest still land, and the user is told', async ({
  page,
  request,
}) => {
  const GONE = 'Deleted while away';
  const KEPT = 'Kept while away';
  const { token, habitIds } = await arrange(page, request, 'offline-poison', [GONE, KEPT]);
  const [goneId, keptId] = habitIds as [number, number];
  const queue = await queueOffline(page, [
    [GONE, 1],
    [KEPT, 1],
  ]);
  const [goneKey, keptKey] = operationIds(queue).map(replayKey);
  expect(await goalIdsOf(request, token, goneId)).toContain(queue[0]!.goal_id);
  expect(await goalIdsOf(request, token, keptId)).toContain(queue[1]!.goal_id);

  // Out of band, the habit behind the head entry goes away: its replay is a real 404.
  const deleted = await request.delete(`${backendUrl()}/habits/${goneId}`, {
    headers: bearer(token),
  });
  expect(deleted.ok()).toBe(true);

  const log = completionLog(page);
  await goOnline(page);
  log.mark();
  await replayFromShelf(page, null);

  const posted = await log.settleAt(2, 'one replay POST per queued check-in');
  expect(posted.map((post) => post.key)).toEqual([goneKey, keptKey]);
  expect(posted[0]!.status).toBe(HTTP_NOT_FOUND);
  expect(posted[1]!.ok, `the kept replay answered ${posted[1]!.status}`).toBe(true);
  expect(await serverUnits(request, token, keptId)).toBe(1);
  const goneRead = await request.get(`${backendUrl()}/habits/${goneId}`, {
    headers: bearer(token),
  });
  expect(goneRead.status()).toBe(HTTP_NOT_FOUND);

  await openHabits(page);
  const notice = page.getByTestId('dropped-check-in-notice');
  await expect(page.getByRole('alert').filter({ hasText: DROPPED_ONE })).toBeVisible();
  await expect(notice).toHaveText(new RegExp(`^${DROPPED_ONE}`));
  const dismiss = notice.getByRole('button', { name: DISMISS_LABEL });
  await expect(dismiss).toHaveAttribute('data-testid', 'dismiss-dropped-check-ins');
  await dismiss.click();
  await expect(notice).toHaveCount(0);

  // A further load does not bring it back: the quarantine itself was cleared.
  await openJournal(page);
  await openHabits(page);
  await expect(notice).toHaveCount(0);
});

test('a replay cut off mid-queue keeps exactly the unposted suffix and never re-posts the prefix', async ({
  page,
  request,
}) => {
  const HABIT = 'Interrupted run';
  const { token, habitIds } = await arrange(page, request, 'offline-suffix', [HABIT]);
  const [habitId] = habitIds as [number];
  const ids = operationIds(await queueOffline(page, [[HABIT, QUEUED_TAPS]]));
  const cutKey = replayKey(ids[ABORTED_INDEX]!);

  // Every attempt for one entry's key fails as a dropped connection -- the
  // transport retries a keyed POST, so a one-shot abort would only be retried.
  let cutting = true;
  await page.route(
    (url) => url.origin === new URL(backendUrl()).origin,
    async (route: Route) => {
      const sent = route.request();
      const isCut =
        cutting && isCompletionPost(sent) && (await sent.headerValue('idempotency-key')) === cutKey;
      await (isCut ? route.abort('internetdisconnected') : route.fallback());
    },
  );

  const log = completionLog(page);
  await goOnline(page);
  log.mark();
  await replayFromShelf(page, ids.slice(ABORTED_INDEX));
  const prefix = await log.settleAt(ABORTED_INDEX, 'only the prefix before the cut lands');
  expect(prefix.map((post) => post.key)).toEqual(ids.slice(0, ABORTED_INDEX).map(replayKey));
  expect(prefix.every((post) => post.ok)).toBe(true);
  expect(await serverUnits(request, token, habitId)).toBe(ABORTED_INDEX);

  cutting = false;
  log.mark();
  await replayFromShelf(page, null);
  const rest = await log.settleAt(QUEUED_TAPS - ABORTED_INDEX, 'only the kept suffix is replayed');
  expect(rest.map((post) => post.key)).toEqual(ids.slice(ABORTED_INDEX).map(replayKey));
  expect(rest.every((post) => post.ok)).toBe(true);
  expect(await serverUnits(request, token, habitId)).toBe(QUEUED_TAPS);
  await page.unrouteAll({ behavior: 'wait' });
});

test('a check-in queued yesterday replays today onto yesterday', async ({ page, request }) => {
  const HABIT = 'Late-night stretch';
  const { token, pinnedDay, today, habitIds } = await arrange(
    page,
    request,
    'offline-day',
    [HABIT],
    1,
  );
  const [habitId] = habitIds as [number];
  expect(pinnedDay).not.toBe(today);
  const [entry] = await queueOffline(page, [[HABIT, 1]]);
  expect(dayKeyIn(entry!.timestamp, USER_TIMEZONE)).toBe(pinnedDay);

  // The device reconnects on the server's today, still on a pinned clock.
  await page.clock.setSystemTime(instantAt(today, PINNED_WALL, USER_TIMEZONE));
  const log = completionLog(page);
  await goOnline(page);
  log.mark();
  await replayFromShelf(page, null);

  const [posted] = await log.settleAt(1, 'one replay POST for the queued check-in');
  expect(posted!.ok).toBe(true);
  expect(posted!.body.completed_on).toBe(pinnedDay);
  const completions = completionsOf(await readHabit(request, token, habitId));
  expect(completions.map((completion) => completion.local_day)).toEqual([pinnedDay]);
});

test('a head entry the server keeps refusing past the attempt cap and a week is given up on, visibly', async ({
  page,
  request,
}) => {
  const POISON = 'Always refused';
  const KEPT = 'Behind the refusal';
  const { token, pinnedDay, habitIds } = await arrange(page, request, 'offline-give-up', [
    POISON,
    KEPT,
  ]);
  const [poisonId, keptId] = habitIds as [number, number];
  const queue = await queueOffline(page, [
    [POISON, 1],
    [KEPT, 1],
  ]);
  const [poisonOp, keptOp] = operationIds(queue) as [string, string];
  expect(await goalIdsOf(request, token, poisonId)).toContain(queue[0]!.goal_id);
  expect(await goalIdsOf(request, token, keptId)).toContain(queue[1]!.goal_id);
  const keptKey = replayKey(keptOp);

  // The head has already been refused one time short of the cap, starting more
  // than a week before the pinned clock: the record a long-wedged queue carries.
  const pinnedMs = instantAt(pinnedDay, PINNED_WALL, USER_TIMEZONE).getTime();
  await page.evaluate(
    ({ ownerKey, key, marker, record }) => {
      const owner = localStorage.getItem(ownerKey);
      localStorage.setItem(`${key}${marker}${owner}`, JSON.stringify(record));
    },
    {
      ownerKey: DEVICE_OWNER_KEY,
      key: REPLAY_STATE_KEY_BASE,
      marker: SCOPE_MARKER,
      record: {
        identity: poisonOp,
        attempts: MAX_CHECK_IN_REPLAY_ATTEMPTS - 1,
        first_rejected_at: new Date(pinnedMs - AGE_PAST_POISON_FLOOR_MS).toISOString(),
        last_status: HTTP_SERVER_ERROR,
      },
    },
  );

  // The server answers the head with a status nobody classified, every time.
  const poisonKey = replayKey(poisonOp);
  await page.route(
    (url) => url.origin === new URL(backendUrl()).origin,
    async (route: Route) => {
      const sent = route.request();
      const isPoison =
        isCompletionPost(sent) && (await sent.headerValue('idempotency-key')) === poisonKey;
      await (isPoison
        ? route.fulfill({
            status: HTTP_SERVER_ERROR,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'server_error' }),
          })
        : route.fallback());
    },
  );

  const log = completionLog(page);
  await goOnline(page);
  log.mark();
  await replayFromShelf(page, null);

  // The entry behind the refused head finally lands. A miss says what the
  // server answered and what the device quarantined, so it is diagnosable.
  const landed = await expect
    .poll(() => serverUnits(request, token, keptId))
    .toBe(1)
    .then(
      () => true,
      () => false,
    );
  if (!landed) {
    const quarantine = await readScoped(page, DROPPED_KEY_BASE);
    throw new Error(
      `the entry behind the refused head never landed; answered ${JSON.stringify(
        log.sinceMark().map(({ key, status }) => ({ key, status })),
      )}; quarantined ${JSON.stringify(quarantine)}`,
    );
  }
  expect(completionsOf(await readHabit(request, token, poisonId))).toEqual([]);
  expect(await readScoped(page, REPLAY_STATE_KEY_BASE)).toBeNull();
  // The refused key is retried by the transport, so the total is not fixed;
  // the kept key's count is, and it is held for the same quiet window.
  const kept = await log.settleOnKey(keptKey, 1, 'the entry behind the head posts exactly once');
  expect(kept.map((post) => post.ok)).toEqual([true]);
  const refusals = log.sinceMark().filter((post) => post.key === poisonKey);
  expect(refusals.length).toBeGreaterThan(0);
  expect(refusals.every((post) => post.status === HTTP_SERVER_ERROR)).toBe(true);

  // Given up on, not rejected outright: the quarantine says which, and names the entry.
  const quarantine = (await readScoped(page, DROPPED_KEY_BASE)) as Array<
    Record<string, unknown>
  > | null;
  expect(quarantine).toHaveLength(1);
  expect(quarantine![0]).toMatchObject({
    reason: 'gave_up',
    status: HTTP_SERVER_ERROR,
    operation_id: poisonOp,
  });

  await openHabits(page);
  await expect(page.getByRole('alert').filter({ hasText: DROPPED_ONE })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
});
