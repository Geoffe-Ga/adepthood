/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { PracticeInsightsResponse, WeekCountResponse } from '@/api';

const mockInsights = jest.fn() as jest.MockedFunction<() => Promise<PracticeInsightsResponse>>;
const mockWeekCount = jest.fn() as jest.MockedFunction<() => Promise<WeekCountResponse>>;

jest.mock('@/api', () => ({
  practiceSessions: {
    insights: (...args: unknown[]) =>
      (mockInsights as unknown as (...a: unknown[]) => Promise<PracticeInsightsResponse>)(...args),
    weekCount: (...args: unknown[]) =>
      (mockWeekCount as unknown as (...a: unknown[]) => Promise<WeekCountResponse>)(...args),
  },
}));

const { useWeeklyProgress } = require('../useWeeklyProgress');

function insightsFixture(counts: number[]): PracticeInsightsResponse {
  return {
    weekly_counts: counts.map((count, i) => ({
      week_start: `2026-01-${String(i + 1).padStart(2, '0')}`,
      count,
    })),
    streak_weeks: 0,
    total_minutes_30d: 0,
    avg_duration_minutes_30d: null,
    per_mode_counts: {},
    last_insight: null,
  };
}

describe('useWeeklyProgress', () => {
  beforeEach(() => {
    mockInsights.mockReset();
    mockWeekCount.mockReset();
  });

  it('prefers the latest weekly_counts bucket when insights resolves', async () => {
    mockInsights.mockResolvedValue(insightsFixture([2, 5]));

    const { result } = renderHook(() => useWeeklyProgress());

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.count).toBe(5);
    expect(result.current.error).toBeNull();
    expect(mockWeekCount).not.toHaveBeenCalled();
  });

  it('returns 0 without calling the legacy endpoint when weekly_counts is empty', async () => {
    mockInsights.mockResolvedValue(insightsFixture([]));

    const { result } = renderHook(() => useWeeklyProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.count).toBe(0);
    expect(mockWeekCount).not.toHaveBeenCalled();
  });

  it('falls back to the legacy weekCount endpoint when insights rejects', async () => {
    mockInsights.mockRejectedValue(new Error('insights unavailable'));
    mockWeekCount.mockResolvedValue({ count: 3 });

    const { result } = renderHook(() => useWeeklyProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.count).toBe(3);
    expect(result.current.error).toBeNull();
    expect(mockWeekCount).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error when both insights and the legacy fallback fail', async () => {
    mockInsights.mockRejectedValue(new Error('insights down'));
    mockWeekCount.mockRejectedValue(new Error('legacy down'));

    const { result } = renderHook(() => useWeeklyProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('legacy down');
  });

  it('wraps a non-Error rejection into a real Error', async () => {
    mockInsights.mockRejectedValue('boom');
    mockWeekCount.mockRejectedValue('still boom');

    const { result } = renderHook(() => useWeeklyProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('still boom');
  });

  it('refresh() re-fetches and clears a prior error', async () => {
    mockInsights.mockRejectedValueOnce(new Error('first try'));
    mockWeekCount.mockRejectedValueOnce(new Error('first legacy'));
    mockInsights.mockResolvedValueOnce(insightsFixture([9]));

    const { result } = renderHook(() => useWeeklyProgress());
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.count).toBe(9);
  });

  it('increment() bumps the count by one', async () => {
    mockInsights.mockResolvedValue(insightsFixture([1]));

    const { result } = renderHook(() => useWeeklyProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.increment();
    });

    expect(result.current.count).toBe(2);
  });

  it('decrement() reduces the count but floors at zero', async () => {
    mockInsights.mockResolvedValue(insightsFixture([1]));

    const { result } = renderHook(() => useWeeklyProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.decrement();
      result.current.decrement();
    });

    expect(result.current.count).toBe(0);
  });

  it('setCount replaces the count with an authoritative value', async () => {
    mockInsights.mockResolvedValue(insightsFixture([1]));

    const { result } = renderHook(() => useWeeklyProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setCount(42);
    });

    expect(result.current.count).toBe(42);
  });

  it('ignores a stale resolution if the component unmounted first', async () => {
    let resolveInsights: ((value: PracticeInsightsResponse) => void) | undefined;
    mockInsights.mockReturnValueOnce(
      new Promise<PracticeInsightsResponse>((resolve) => {
        resolveInsights = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useWeeklyProgress());
    unmount();
    await act(async () => {
      resolveInsights?.(insightsFixture([7]));
    });

    // No setState should have landed post-unmount; state is whatever it was
    // pre-unmount (still loading, count 0).
    expect(result.current.isLoading).toBe(true);
    expect(result.current.count).toBe(0);
  });

  it('ignores a stale rejection if the component unmounted first', async () => {
    let rejectInsights: ((err: Error) => void) | undefined;
    mockInsights.mockReturnValueOnce(
      new Promise<PracticeInsightsResponse>((_resolve, reject) => {
        rejectInsights = reject;
      }),
    );
    mockWeekCount.mockRejectedValue(new Error('legacy down'));

    const { result, unmount } = renderHook(() => useWeeklyProgress());
    unmount();
    await act(async () => {
      rejectInsights?.(new Error('insights down'));
    });

    expect(result.current.error).toBeNull();
  });
});
