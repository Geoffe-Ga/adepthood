/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { PracticeStatsResponse, UserPractice } from '@/api';

/**
 * The screen test (`PracticeDetailScreen.stats.test.tsx`) covers what a
 * practitioner sees. This file covers the two things the screen cannot make
 * visible: which requests are issued in which order, and what happens when the
 * screen is gone before an answer arrives.
 */

const mockList = jest.fn() as jest.MockedFunction<() => Promise<UserPractice[]>>;
const mockStats = jest.fn() as jest.MockedFunction<(_id: number) => Promise<PracticeStatsResponse>>;

jest.mock('@/api', () => ({
  userPractices: {
    list: (...args: unknown[]) =>
      (mockList as unknown as (...a: unknown[]) => Promise<UserPractice[]>)(...args),
  },
  practiceSessions: {
    stats: (...args: unknown[]) =>
      (mockStats as unknown as (...a: unknown[]) => Promise<PracticeStatsResponse>)(...args),
  },
}));

const { usePracticeStats } = require('../usePracticeStats');

const PRACTICE_ID = 77;
const ADOPTION_ID = 12;

function adoption(overrides: Partial<UserPractice> = {}): UserPractice {
  return {
    id: ADOPTION_ID,
    practice_id: PRACTICE_ID,
    stage_number: 1,
    start_date: '2026-05-23',
    end_date: null,
    ...overrides,
  };
}

/** A promise this test decides when to settle, so a race can be staged. */
function deferred<T>(): { promise: Promise<T>; resolve: (_value: T) => void } {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('usePracticeStats', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockStats.mockReset();
  });

  it('reports the totals for the caller’s own adoption of this practice', async () => {
    mockList.mockResolvedValue([adoption({ id: 5, practice_id: 999 }), adoption()]);
    mockStats.mockResolvedValue({ total_sessions: 3, total_minutes: 75 });

    const { result } = renderHook(() => usePracticeStats(PRACTICE_ID));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockStats).toHaveBeenCalledWith(ADOPTION_ID);
    expect(result.current.stats).toEqual({ total_sessions: 3, total_minutes: 75 });
  });

  it('never asks for an aggregate when the practice was never adopted', async () => {
    mockList.mockResolvedValue([adoption({ id: 5, practice_id: 999 })]);

    const { result } = renderHook(() => usePracticeStats(PRACTICE_ID));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockStats).not.toHaveBeenCalled();
    expect(result.current.stats).toBeNull();
  });

  it('swallows a failed aggregate rather than surfacing an error', async () => {
    mockList.mockResolvedValue([adoption()]);
    mockStats.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => usePracticeStats(PRACTICE_ID));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.stats).toBeNull();
  });

  it('issues no aggregate request for a screen that is already gone', async () => {
    // The guard after the listing is the one worth pinning: skipping it costs a
    // real request on behalf of a screen nobody is looking at. The guards after
    // the aggregate resolves are the same convention as `useActivePractice` and
    // `useWeeklyProgress`, but React 18 no longer warns on a state write into a
    // torn-down instance, so there is nothing observable for a test to assert
    // and no test is written here that would pass whether or not they existed.
    const listing = deferred<UserPractice[]>();
    mockList.mockReturnValue(listing.promise);

    const { unmount } = renderHook(() => usePracticeStats(PRACTICE_ID));
    unmount();

    await act(async () => {
      listing.resolve([adoption()]);
      await listing.promise;
    });

    expect(mockStats).not.toHaveBeenCalled();
  });
});
