/* eslint-env jest */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { waitFor } from '@testing-library/react-native';

import { ASYNC_UTIL_TIMEOUT_MS, JEST_TEST_TIMEOUT_MS } from '@/testing/asyncBudget';

/** RNTL's polling interval for waitFor / findBy* (its DEFAULT_INTERVAL). */
const RNTL_POLL_INTERVAL_MS = 50;
/** The fake-clock slack allowed past the budget: the poll that notices it. */
const EXPIRY_SLACK_MS = 2 * RNTL_POLL_INTERVAL_MS;
/** RNTL's own default, which the shared budget must actually replace. */
const RNTL_DEFAULT_ASYNC_UTIL_TIMEOUT_MS = 1000;

describe('the shared async-util budget', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('leaves a wait that uses all of it inside the Jest test timeout', () => {
    expect(ASYNC_UTIL_TIMEOUT_MS).toBeLessThan(JEST_TEST_TIMEOUT_MS);
  });

  it("is the budget every waitFor gets, not RNTL's default", async () => {
    // Under fake timers RNTL advances the fake clock one poll at a time and
    // gives up when the fake clock passes the budget, so the elapsed fake time
    // measures the budget exactly and costs no wall-clock time at all.
    jest.useFakeTimers();
    const started = Date.now();

    await expect(
      waitFor(() => {
        throw new Error('never satisfied');
      }),
    ).rejects.toThrow('never satisfied');

    const elapsed = Date.now() - started;
    expect(ASYNC_UTIL_TIMEOUT_MS).not.toBe(RNTL_DEFAULT_ASYNC_UTIL_TIMEOUT_MS);
    expect(elapsed).toBeGreaterThanOrEqual(ASYNC_UTIL_TIMEOUT_MS);
    expect(elapsed).toBeLessThanOrEqual(ASYNC_UTIL_TIMEOUT_MS + EXPIRY_SLACK_MS);
  });
});
