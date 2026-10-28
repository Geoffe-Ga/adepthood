/**
 * Browser-lane support for the day-boundary journey (#2771): counting the reads
 * a mounted screen issues, seeding a habit that is done today on the SERVER's
 * calendar, and the two page-side levers -- a blocked boundary read and a
 * background/foreground round trip.
 */
import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';

import { backendUrl, bearer } from './journalHabitsBrowserSupport';

/**
 * How long a count must hold still before it is believed. An exact count is the
 * point of these specs -- one read on return, not one-or-more -- so a tally is
 * polled up to its target and then watched for a quiet window, inside which a
 * duplicate read would land.
 */
const SETTLE_MS = 750;
/** A read the client does not retry, and that leaves a cached list on screen. */
const STUB_STATUS = 404;
const HABITS_LIST_PATH = '/habits/';
const COMPLETIONS_PATH = '/goal_completions/';
/** Any past day: the journey is about when the completion is, not when the habit began. */
const HABIT_START_DATE = '2026-01-01';
const HABIT_ENERGY_COST = 2;
const HABIT_ENERGY_RETURN = 4;

/** The paginated habit list every habit surface loads through `habits.listAll`. */
export function isHabitsListRead(request: Request): boolean {
  const url = new URL(request.url());
  return (
    request.method() === 'GET' &&
    url.pathname === HABITS_LIST_PATH &&
    url.searchParams.get('paginate') === 'true'
  );
}

export function isCompletionPost(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === COMPLETIONS_PATH;
}

export interface RequestTally {
  /** Start counting afresh from now. */
  mark: () => void;
  /** Requests seen since the last mark. */
  sinceMark: () => number;
  /** Exactly `count` requests since the last mark, and no more after a quiet window. */
  expectSinceMark: (count: number, because: string) => Promise<void>;
}

/** Count every request `matches` accepts from the moment this is called. */
export function requestTally(page: Page, matches: (request: Request) => boolean): RequestTally {
  let seen = 0;
  let marked = 0;
  page.on('request', (request) => {
    if (matches(request)) seen += 1;
  });
  const sinceMark = (): number => seen - marked;
  return {
    mark: () => {
      marked = seen;
    },
    sinceMark,
    expectSinceMark: async (count, because) => {
      await expect.poll(sinceMark, { message: because }).toBeGreaterThanOrEqual(count);
      await page.waitForTimeout(SETTLE_MS);
      expect(sinceMark(), because).toBe(count);
    },
  };
}

interface CompletionRead {
  local_day: string;
  completed_units: number;
}

interface GoalRead {
  id: number;
  tier: string;
  completions?: CompletionRead[];
}

export interface HabitRead {
  id: number;
  goals: GoalRead[];
}

export async function readHabit(
  request: APIRequestContext,
  token: string,
  habitId: number,
): Promise<HabitRead> {
  const response = await request.get(`${backendUrl()}/habits/${habitId}`, {
    headers: bearer(token),
  });
  expect(response.ok(), 'reading the habit back failed').toBe(true);
  return (await response.json()) as HabitRead;
}

/** Every completion on the habit, across its tiers. */
export function completionsOf(habit: HabitRead): CompletionRead[] {
  return habit.goals.flatMap((goal) => goal.completions ?? []);
}

export interface SeededCompletion {
  habitId: number;
  /** The day the SERVER bucketed the completion into, in the account's zone. */
  localDay: string;
}

/**
 * A revealed habit with every tier met today, as the server reckons today.
 *
 * Revealed, because the journal shelf counts unlocked habits only and a locked
 * tile shows no streak line at all. The STRETCH tier is the one checked in:
 * the tile reads "achieved today" only once the whole set is met, and an
 * amount-less check-in logs that tier's full target, which clears the two
 * below it on the same bar. The server stamps the completion with its own
 * clock and the account's zone, so the day it returns is the one fact every
 * fake page time is built from -- never the host's clock, which can sit on the
 * other side of the account's midnight.
 */
export async function seedRevealedHabitDoneToday(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<SeededCompletion> {
  const created = await request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name,
      icon: '★',
      start_date: HABIT_START_DATE,
      energy_cost: HABIT_ENERGY_COST,
      energy_return: HABIT_ENERGY_RETURN,
      revealed: true,
    },
  });
  expect(created.ok(), `seeding ${name} failed`).toBe(true);
  const habitId = ((await created.json()) as { id: number }).id;
  const stretch = (await readHabit(request, token, habitId)).goals.find(
    (goal) => goal.tier === 'stretch',
  );
  if (stretch === undefined) throw new Error('the seeded habit has no stretch tier to meet');
  const checkIn = await request.post(`${backendUrl()}${COMPLETIONS_PATH}`, {
    headers: bearer(token),
    data: { goal_id: stretch.id, did_complete: true },
  });
  expect(checkIn.ok(), 'seeding the check-in failed').toBe(true);
  const [completion] = completionsOf(await readHabit(request, token, habitId));
  if (completion === undefined) throw new Error('the seeded check-in did not land');
  return { habitId, localDay: completion.local_day };
}

/** Tier markers drawn met: only the met star carries a gradient fill. */
export async function litTierMarkers(tile: Locator): Promise<number> {
  return tile.locator('[data-testid^="marker-"] linearGradient').count();
}

/**
 * Answer the habit list with a 404 until restored.
 *
 * Fulfilled rather than aborted: an aborted GET is a network error, which the
 * client retries twice on the page's clock, so one attempt would become three.
 * A 404 is not retried, and a store already holding rows keeps them -- so
 * whatever the screen shows afterwards is built from the rows it already had.
 */
export async function stubHabitsListReadsNotFound(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === HABITS_LIST_PATH && url.searchParams.get('paginate') === 'true',
    async (route) => {
      // Only the read is held back; a CORS preflight goes to the server as usual.
      await (route.request().method() === 'GET'
        ? route.fulfill({
            status: STUB_STATUS,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'held back across the day boundary' }),
          })
        : route.fallback());
    },
  );
}

export async function restoreHabitsListReads(page: Page): Promise<void> {
  await page.unrouteAll({ behavior: 'wait' });
}

/**
 * Send the page to the background and bring it back, the way a browser does
 * when its tab is hidden and shown again.
 *
 * A headless page is always visible, so the document's own visibility is
 * shadowed for the hidden half and the shadow removed for the visible one; the
 * events are the real `visibilitychange` react-native-web's `AppState` listens
 * for.
 */
export async function simulateBackgroundAndForeground(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'visibilityState');
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
