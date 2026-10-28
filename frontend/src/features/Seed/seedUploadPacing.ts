/**
 * Keeps a seeding run under the upload endpoint's rate limit, and waits out a
 * refusal when one comes anyway (#3556, owner decision R1-5).
 *
 * `POST /corpus/import` admits {@link SEED_UPLOAD_LIMIT} uploads per
 * {@link SEED_UPLOAD_WINDOW_MS} from one client, counted on a moving window. A
 * folder holds far more than that, and a run that simply sent them one after
 * another would get its twenty-first and every later document refused. So the
 * run asks the pacer before each send: below the limit nothing waits at all, and
 * at it the next document waits only until the oldest upload has left the
 * window.
 *
 * **Timestamps are taken when the answer comes back.** The server counts an
 * upload at some moment before it answers, so the answer's arrival is the
 * latest that count can have been. Measuring the window from there means a slow
 * first upload cannot leave its count inside the window the pacer thinks has
 * passed.
 *
 * Pacing is a courtesy, not the guarantee: another tab, or a pick sent a moment
 * earlier, shares the same bucket. A 429 that arrives anyway is waited out for
 * as long as the server's `Retry-After` says, a bounded number of times, and
 * every wait here can be stopped.
 */

/** Uploads the endpoint admits per window: `UPLOAD_RATE_LIMIT = "20/minute"`. */
export const SEED_UPLOAD_LIMIT = 20;

/** The window that limit is counted over, in milliseconds. */
export const SEED_UPLOAD_WINDOW_MS = 60_000;

/**
 * Slack added after the window, for the two clocks (this device's and the
 * server's) rounding differently. A second is invisible beside a minute's wait
 * and keeps the paced send from landing on the window's very edge.
 */
export const SEED_UPLOAD_PACING_MARGIN_MS = 1_000;

/** How many times one document waits out a refusal before it settles. */
export const MAX_SEED_RATE_LIMIT_WAITS = 3;

/**
 * The longest single wait a run will sit through. Twice the window: a refusal
 * from this endpoint's own limit never asks for more, so a longer one is some
 * other limit, and the document settles where it can be sent again later rather
 * than holding the screen for an hour.
 */
export const MAX_SEED_RATE_LIMIT_WAIT_MS = 2 * SEED_UPLOAD_WINDOW_MS;

const MS_PER_SECOND = 1_000;

/** The shortest honest wait: the server never asks for less than a second. */
const MIN_RATE_LIMIT_WAIT_MS = MS_PER_SECOND;

/** The run's side of the moving window. */
export interface SeedUploadPacer {
  /** How long the next send must wait to stay under the limit; 0 to go now. */
  delayMs: () => number;
  /** Count an upload whose answer just came back. */
  record: () => void;
}

/** A pacer over `clock`, holding only the answer times still inside the window. */
export function createSeedUploadPacer(clock: () => number = Date.now): SeedUploadPacer {
  let answered: number[] = [];
  const horizon = SEED_UPLOAD_WINDOW_MS + SEED_UPLOAD_PACING_MARGIN_MS;
  const prune = (now: number): void => {
    answered = answered.filter((at) => now - at < horizon);
  };
  return {
    delayMs: () => {
      const now = clock();
      prune(now);
      if (answered.length < SEED_UPLOAD_LIMIT) return 0;
      const oldest = answered[answered.length - SEED_UPLOAD_LIMIT] ?? now;
      return Math.max(0, oldest + horizon - now);
    },
    record: () => {
      answered.push(clock());
    },
  };
}

/**
 * How long to wait out a 429, from its `Retry-After` in seconds.
 *
 * No header (or one this client could not read) waits one whole window, which
 * is certain to find the bucket open. A wait past
 * {@link MAX_SEED_RATE_LIMIT_WAIT_MS} answers null: not worth sitting through.
 */
export function rateLimitWaitMs(retryAfterSeconds: number | null): number | null {
  if (retryAfterSeconds === null) return SEED_UPLOAD_WINDOW_MS;
  const waitMs = Math.max(MIN_RATE_LIMIT_WAIT_MS, retryAfterSeconds * MS_PER_SECOND);
  return waitMs > MAX_SEED_RATE_LIMIT_WAIT_MS ? null : waitMs;
}

/**
 * Wait `ms`, or less if the run is stopped first. Resolves true when the time
 * passed and false when `signal` aborted, leaving no timer behind either way.
 */
export function waitOrStop(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const stop = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
