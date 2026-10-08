/**
 * Browser-lane support for the demo-tile journey (#2491): the copy the spec
 * looks for, and the pure classifiers that decide which requests count.
 *
 * Pure, and importing nothing at runtime, so `__tests__/demoTileBrowserSupport.test.ts`
 * can pin the classifiers. That matters because the journey's load-bearing
 * assertion is an ABSENCE -- no request put a demo tile's fabricated id on the
 * wire -- and an absence asserted through a pattern that cannot match anything
 * passes forever. Every pattern here is exercised against a matching URL in jest.
 */

/**
 * What a check-in on a demo tile says instead of a milestone
 * (`showDemoSeedNotice`, src/features/Habits/hooks/useHabitActions.ts).
 */
export const DEMO_SEED_TOAST =
  "These are sample habits to explore — this one isn't saved to your account. Add your own to start tracking.";

/**
 * What the Habits screen says when its list fetch fails at the network: an
 * aborted request is a transport failure, which `formatApiError` words as
 * `UNREACHABLE_MESSAGE` (src/api/errorMessages.ts) rather than the screen's own
 * fallback copy.
 */
export const HABITS_UNREACHABLE = "We couldn't reach the server.";

/** The title every habit write-failure alert carries (`SYNC_FAILURE_TITLE` in habitManager.ts). */
export const SYNC_FAILURE_TITLE = "Couldn't sync";

/** What the stats modal shows while it waits on the server. */
export const LOADING_STATS = 'Loading stats...';

/** Every on-device habit cache key starts with this (`HABITS_KEY_BASE` in habitStorage.ts). */
export const HABITS_CACHE_PREFIX = '@adepthood/habits';

/** The habit list's pathname: the one read the journey forces to fail. */
export const HABITS_LIST_PATH = '/habits/';

/** One request a demo tile must never cause, named the way journeys.json names its route. */
export interface ForbiddenWire {
  readonly method: string;
  readonly path: RegExp;
  readonly route: string;
}

/**
 * Every write (and the one per-habit read) a server-backed tile sends and a
 * demo tile must not. A fresh demo account owns no habit at all, so ANY id on
 * these paths is a fabricated one -- the patterns take every numeric id rather
 * than only 1..10, which would let an off-by-one id slip past.
 */
export const FORBIDDEN_DEMO_WIRE: readonly ForbiddenWire[] = [
  { method: 'PUT', path: /^\/habits\/\d+$/u, route: 'PUT /habits/{habit_id}' },
  { method: 'DELETE', path: /^\/habits\/\d+$/u, route: 'DELETE /habits/{habit_id}' },
  {
    method: 'DELETE',
    path: /^\/habits\/\d+\/completions$/u,
    route: 'DELETE /habits/{habit_id}/completions',
  },
  {
    method: 'PUT',
    path: /^\/habits\/\d+\/goals\/units$/u,
    route: 'PUT /habits/{habit_id}/goals/units',
  },
  { method: 'PUT', path: /^\/goals\/\d+$/u, route: 'PUT /goals/{goal_id}' },
  { method: 'POST', path: /^\/goal_completions\/$/u, route: 'POST /goal_completions/' },
  { method: 'GET', path: /^\/habits\/\d+\/stats$/u, route: 'GET /habits/{habit_id}/stats' },
];

/** A request as the spec records it: enough to classify, nothing more. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
}

/** Whether `url` is served by `apiOrigin` -- never the frontend's own routes. */
function onApi(url: URL, apiOrigin: string): boolean {
  return url.origin === new URL(apiOrigin).origin;
}

/**
 * The habit list read, and only that: the API origin, `GET`, and the exact
 * collection pathname. The frontend serves its own `/habits/` route (the tab's
 * deep link), and a reload of that page must never be the request aborted.
 */
export function isHabitsListGet(method: string, url: string, apiOrigin: string): boolean {
  const parsed = new URL(url);
  return method === 'GET' && onApi(parsed, apiOrigin) && parsed.pathname === HABITS_LIST_PATH;
}

/** Every recorded request a demo tile must not have caused, as `METHOD /path`. */
export function forbiddenDemoRequests(
  records: readonly RecordedRequest[],
  apiOrigin: string,
): string[] {
  return records.flatMap(({ method, url }) => {
    const parsed = new URL(url);
    if (!onApi(parsed, apiOrigin)) return [];
    const hit = FORBIDDEN_DEMO_WIRE.some(
      (forbidden) => forbidden.method === method && forbidden.path.test(parsed.pathname),
    );
    return hit ? [`${method} ${parsed.pathname}`] : [];
  });
}
