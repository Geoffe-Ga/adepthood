/**
 * Warm the web bundle before the first browser journey runs.
 *
 * Expo's dev server answers the HTML shell as soon as it listens, but Metro
 * compiles the JS bundle the shell references only when that bundle is first
 * requested. Global setup used to stop at the shell, so the first spec to
 * navigate paid the whole cold compile inside its own action timeout -- and
 * which spec that is depends only on file order. Fetching every bundle here,
 * inside setup's boot deadline, moves that cost to the one place that is
 * budgeted for it.
 *
 * Pure apart from the injected `fetchImpl`, so `__tests__/bundleWarmup.test.ts`
 * can pin both halves without a live server.
 */

/** The slice of `fetch` the warm-up uses, so a test can script its answers. */
export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface WarmOptions {
  /** Epoch milliseconds after which a bundle still not served is a failure. */
  deadline: number;
  fetchImpl: FetchLike;
  /** Pause between attempts at one bundle. */
  retryMs: number;
}

/** A `<script>` tag's `src`, in either quote style. Inline scripts have none. */
const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;
/** The first client error status: a 4xx will not turn into a bundle by waiting. */
const CLIENT_ERROR = 400;
const SERVER_ERROR = 500;

/**
 * Every `<script src>` in `html`, resolved against `baseUrl`, in document order.
 *
 * Throws when there is none: a shell with nothing to warm means the page
 * changed shape, and warming nothing would pass while leaving the first spec
 * to pay the compile again.
 */
export function scriptUrls(html: string, baseUrl: string): string[] {
  const urls = [...html.matchAll(SCRIPT_SRC)].map((match) =>
    new URL((match[2] ?? '').replaceAll('&amp;', '&'), baseUrl).toString(),
  );
  if (urls.length === 0) {
    throw new Error(
      `the page at ${baseUrl} references no <script src>, so there is no bundle to warm`,
    );
  }
  return urls;
}

/** What one request produced: its status and body, or the error that stopped it. */
async function request(
  url: string,
  fetchImpl: FetchLike,
): Promise<{ status: number; ok: boolean; body: string } | { error: string }> {
  try {
    const response = await fetchImpl(url);
    return { status: response.status, ok: response.ok, body: await response.text() };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One attempt at a bundle: `null` once it is served, else why not. A 4xx
 * throws -- a bundle that is not there will not appear by waiting for it.
 */
async function attempt(url: string, fetchImpl: FetchLike): Promise<string | null> {
  const outcome = await request(url, fetchImpl);
  if ('error' in outcome) return outcome.error;
  if (outcome.ok && outcome.body.length > 0) return null;
  if (outcome.status >= CLIENT_ERROR && outcome.status < SERVER_ERROR) {
    throw new Error(
      `the web bundle ${url} answered ${String(outcome.status)}; it will not compile by waiting`,
    );
  }
  return `${String(outcome.status)} with ${String(outcome.body.length)} bytes`;
}

/**
 * Fetch each URL until it answers 200 with a non-empty body, before `deadline`.
 *
 * A connection error, a 5xx (Metro mid-compile or reporting a build error)
 * or an empty body is retried until the deadline, then reported with the
 * last outcome. A 4xx fails at once: a bundle that is not there will not
 * appear by waiting for it.
 */
export async function warmBundles(urls: readonly string[], options: WarmOptions): Promise<void> {
  if (urls.length === 0) throw new Error('there is nothing to warm: no bundle URL was given');
  for (const url of urls) {
    let last = await attempt(url, options.fetchImpl);
    while (last !== null) {
      if (Date.now() >= options.deadline) {
        throw new Error(
          `the web bundle ${url} did not answer 200 with a body before the deadline (last: ${last})`,
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, options.retryMs));
      last = await attempt(url, options.fetchImpl);
    }
  }
}
