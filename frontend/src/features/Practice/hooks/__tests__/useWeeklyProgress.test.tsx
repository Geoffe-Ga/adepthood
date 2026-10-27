/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { PracticeInsightsResponse, WeekCountResponse } from '@/api';
import { beginAuthSession, installSessionTokenGetter } from '@/api/sessionToken';
import { beginActiveUserTransition, setActiveUser } from '@/storage/userScope';

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
const tokenFor = (owner: number) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: String(owner), exp: 4102444800 })).toString('base64url')}.test`;
let liveToken: string | null;
beforeEach(() => {
  setActiveUser(1);
  liveToken = tokenFor(1);
  installSessionTokenGetter(() => liveToken);
});
afterEach(() => {
  installSessionTokenGetter(null);
  setActiveUser(null);
});

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

describe('weekly account and credential boundaries', () => {
  beforeEach(() => {
    mockInsights.mockReset();
    mockWeekCount.mockReset();
  });
  it('retains the full insights payload on success', async () => {
    const insights = { ...insightsFixture([4]), total_minutes_30d: 123, last_insight: 'Quiet.' };
    mockInsights.mockResolvedValue(insights);
    const { result } = renderHook(() => useWeeklyProgress());
    await waitFor(() => expect(result.current.count).toBe(4));
    expect(result.current.insights).toEqual(insights);
    expect(mockInsights).toHaveBeenCalledWith(liveToken);
  });
  it.each(['missing', 'malformed', 'mismatch', 'transition'])(
    'refuses dispatch for %s credentials',
    (kind) => {
      if (kind === 'missing') liveToken = null;
      if (kind === 'malformed') liveToken = 'unparseable';
      if (kind === 'mismatch') liveToken = tokenFor(2);
      if (kind === 'transition') beginActiveUserTransition();
      const { result } = renderHook(() => useWeeklyProgress());
      act(() => result.current.increment());
      expect(mockInsights).not.toHaveBeenCalled();
      expect(result.current.count).toBe(0);
    },
  );
  it.each(['owner', 'credential', 'session', 'ABA'])(
    'refuses a late answer across %s changes',
    async (kind) => {
      let resolve!: (value: PracticeInsightsResponse) => void;
      mockInsights.mockReturnValueOnce(
        new Promise<PracticeInsightsResponse>((done) => {
          resolve = done;
        }),
      );
      mockInsights.mockResolvedValue(insightsFixture([2]));
      const { result } = renderHook(() => useWeeklyProgress());
      await act(async () => {
        if (kind === 'owner') setActiveUser(2);
        if (kind === 'credential') liveToken = tokenFor(2);
        if (kind === 'session') beginAuthSession();
        if (kind === 'ABA') {
          setActiveUser(2);
          setActiveUser(1);
        }
        resolve(insightsFixture([999]));
      });
      expect(result.current.count).not.toBe(999);
    },
  );
  it('accepts a same-owner renewal without a session boundary', async () => {
    let resolve!: (value: PracticeInsightsResponse) => void;
    mockInsights.mockReturnValueOnce(
      new Promise<PracticeInsightsResponse>((done) => {
        resolve = done;
      }),
    );
    mockInsights.mockReturnValue(new Promise<PracticeInsightsResponse>(() => {}));
    const { result } = renderHook(() => useWeeklyProgress());
    await act(async () => {
      liveToken = `${tokenFor(1)}renewed`;
      resolve(insightsFixture([3]));
    });
    expect(result.current.count).toBe(3);
  });
  it('does not send a fallback under the next owner credential', async () => {
    let reject!: (error: Error) => void;
    mockInsights.mockReturnValueOnce(
      new Promise<PracticeInsightsResponse>((_done, fail) => {
        reject = fail;
      }),
    );
    const { result } = renderHook(() => useWeeklyProgress());
    await act(async () => {
      liveToken = tokenFor(2);
      reject(new Error('offline'));
    });
    expect(mockWeekCount).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });
});

describe('weekly private fields during optimistic boundary changes', () => {
  beforeEach(() => {
    mockInsights.mockReset();
    mockWeekCount.mockReset();
  });
  it.each(['owner', 'session'])(
    'never promotes the previous insights across a new %s key',
    async (boundary) => {
      mockInsights.mockResolvedValueOnce({
        ...insightsFixture([2]),
        last_insight: 'Private old insight.',
      });
      const { result, rerender } = renderHook(() => useWeeklyProgress());
      await waitFor(() =>
        expect(result.current.insights?.last_insight).toBe('Private old insight.'),
      );
      mockInsights.mockReturnValue(new Promise<PracticeInsightsResponse>(() => {}));
      act(() => {
        if (boundary === 'owner') {
          liveToken = tokenFor(2);
          setActiveUser(2);
        } else {
          beginAuthSession();
          rerender({});
        }
      });
      act(() => {
        result.current.increment();
        result.current.setCount(7);
      });
      expect(result.current.count).toBe(7);
      expect(result.current.insights).toBeNull();
      expect(result.current.error).toBeNull();
    },
  );
});
