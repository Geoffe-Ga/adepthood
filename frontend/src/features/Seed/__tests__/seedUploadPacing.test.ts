/* eslint-env jest */
/* global describe, test, expect, afterEach, jest */
import {
  createSeedUploadPacer,
  MAX_SEED_RATE_LIMIT_WAIT_MS,
  rateLimitWaitMs,
  SEED_UPLOAD_LIMIT,
  SEED_UPLOAD_PACING_MARGIN_MS,
  SEED_UPLOAD_WINDOW_MS,
  waitOrStop,
} from '../seedUploadPacing';

const MS_PER_SECOND = 1000;

afterEach(() => {
  jest.useRealTimers();
});

/** A pacer on a clock the test moves by hand. */
function pacerAt(start = 0) {
  let now = start;
  const pacer = createSeedUploadPacer(() => now);
  return {
    pacer,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the upload pacer', () => {
  test('lets a whole window of uploads go without waiting', () => {
    const { pacer } = pacerAt();

    for (let sent = 0; sent < SEED_UPLOAD_LIMIT; sent += 1) {
      expect(pacer.delayMs()).toBe(0);
      pacer.record();
    }
  });

  test('holds the next one until the oldest upload has left the window', () => {
    const { pacer, advance } = pacerAt();
    for (let sent = 0; sent < SEED_UPLOAD_LIMIT; sent += 1) {
      pacer.record();
      advance(MS_PER_SECOND);
    }

    // The first answer came back at 0; the window lets the next one go once a
    // whole window (and the margin) has passed since it.
    const elapsed = SEED_UPLOAD_LIMIT * MS_PER_SECOND;
    expect(pacer.delayMs()).toBe(SEED_UPLOAD_WINDOW_MS + SEED_UPLOAD_PACING_MARGIN_MS - elapsed);
  });

  test('forgets uploads once they are a whole window old', () => {
    const { pacer, advance } = pacerAt();
    for (let sent = 0; sent < SEED_UPLOAD_LIMIT; sent += 1) pacer.record();

    advance(SEED_UPLOAD_WINDOW_MS + SEED_UPLOAD_PACING_MARGIN_MS);

    expect(pacer.delayMs()).toBe(0);
  });
});

describe('how long a rate-limit refusal is waited out', () => {
  test("honours the server's Retry-After in whole seconds", () => {
    expect(rateLimitWaitMs(7)).toBe(7 * MS_PER_SECOND);
  });

  test('waits one whole window when the server named no wait', () => {
    // A client that waits a whole window is certain to find its bucket open.
    expect(rateLimitWaitMs(null)).toBe(SEED_UPLOAD_WINDOW_MS);
  });

  test('never reads a zero or negative wait as "go again at once"', () => {
    expect(rateLimitWaitMs(0)).toBe(MS_PER_SECOND);
    expect(rateLimitWaitMs(-3)).toBe(MS_PER_SECOND);
  });

  test('declines to sit out a wait longer than its cap', () => {
    const tooLong = MAX_SEED_RATE_LIMIT_WAIT_MS / MS_PER_SECOND + 1;

    expect(rateLimitWaitMs(tooLong)).toBeNull();
    expect(rateLimitWaitMs(MAX_SEED_RATE_LIMIT_WAIT_MS / MS_PER_SECOND)).toBe(
      MAX_SEED_RATE_LIMIT_WAIT_MS,
    );
  });
});

describe('a wait that can be stopped', () => {
  test('resolves true once the time has passed', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    let settled: boolean | null = null;
    void waitOrStop(5_000, controller.signal).then((value) => {
      settled = value;
    });

    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  test('resolves false as soon as the run is stopped', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const waiting = waitOrStop(60_000, controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('resolves false at once for a run already stopped', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitOrStop(60_000, controller.signal)).resolves.toBe(false);
  });
});
