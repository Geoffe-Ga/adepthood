/**
 * The environment an Expo web server for the browser lane is started with.
 *
 * Kept pure and free of runtime imports so the jest suite can pin it: what a
 * bundle is built with is decided here, and `EXPO_PUBLIC_*` values are inlined
 * into the bundle when it is built, so a value that leaks in from the shell
 * changes the app under test for every spec that runs against that server.
 *
 * The one value that matters most is the habits demo flag (#2671). The default
 * lane must never be a demo build -- every other habits spec measures rows the
 * server returned, not fixtures -- so the builder fails closed BY VALUE: the
 * flag is always set, to `'false'` unless a caller asks for the demo explicitly
 * through `extra`. Dropping the key would not be enough. `expo start` loads the
 * project's dotenv files (`@expo/env`) before it builds anything and fills a key
 * only when it is undefined, so an absent flag is exactly what would let a
 * developer's gitignored `.env.local` turn the shared lane into a demo build.
 * A defined `'false'` is never overwritten, and `config.ts` treats anything but
 * the literal `'true'` as off.
 */

/**
 * The default lane's frontend port. Development CORS is deliberately explicit
 * (`DEV_ORIGINS` in backend/src/main.py, which `get_cors_origins` returns for
 * `ENV=e2e`), so a random port would make the app report "offline" while both
 * servers are healthy.
 */
export const DEFAULT_FRONTEND_PORT = 3000;

/**
 * The demo-configured frontend's port: the other port `DEV_ORIGINS` already
 * names under both loopback spellings, so the second server needs no backend
 * change to be allowed.
 */
export const DEMO_FRONTEND_PORT = 8080;

/** A process environment, as `spawn` takes one and `process.env` is one. */
export type LaneEnv = typeof process.env;

/** The bundle-time flag that seeds the habits demo tiles (`HABIT_DEMO_MODE`). */
export const HABIT_DEMO_FLAG = 'EXPO_PUBLIC_HABIT_DEMO_MODE';

/** What a demo-configured server is started with on top of the default env. */
export const HABIT_DEMO_ENV: Readonly<Record<string, string>> = { [HABIT_DEMO_FLAG]: 'true' };

/**
 * The env for an Expo web server pointed at `apiUrl`.
 *
 * @param apiUrl - The lane backend the bundle should call.
 * @param inherited - The parent's env, copied rather than mutated.
 * @param extra - Explicit additions, applied last; the only way to turn the demo flag on.
 */
export function frontendServerEnv(
  apiUrl: string,
  inherited: LaneEnv,
  extra: Readonly<Record<string, string>> = {},
): LaneEnv {
  return {
    ...inherited,
    // Defined, not deleted: see the module note on Expo's dotenv loading.
    [HABIT_DEMO_FLAG]: 'false',
    CI: '1',
    EXPO_PUBLIC_API_BASE_URL: apiUrl,
    ...extra,
  };
}
