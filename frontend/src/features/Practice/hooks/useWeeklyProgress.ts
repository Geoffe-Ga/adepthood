/**
 * `useWeeklyProgress` — fetches the current week's session count for the
 * `WeeklyProgress` bar at the foot of `PracticeScreen`.
 *
 * Ritual-04 ships `GET /practice-sessions/insights` (rolling weekly counts,
 * streak, per-mode tallies). This hook prefers the newest `weekly_counts`
 * bucket when the endpoint resolves, and silently falls back to the legacy
 * `weekCount()` endpoint when the insights call fails — purely additive, as
 * the issue requires. The fallback path lets older backends or transient
 * 5xx on the new route keep the bar functional.
 *
 * Optimistic increment / authoritative refetch is preserved from the
 * pre-ritual-11 monolith so the bar still reconciles with server truth
 * after a save (BUG-FE-PRACTICE-005). The `commit` callback inside
 * `useSaveSessionMutation` calls `refresh()` here on success.
 */
import { useCallback, useEffect, useState } from 'react';

import { practiceSessions } from '@/api';
import { useMountedRef } from '@/features/Practice/hooks/useMountedRef';
import { toError } from '@/features/Practice/utils/toError';

export interface UseWeeklyProgressResult {
  count: number;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Optimistic +1. Pair with `decrement()` for rollback. */
  increment: () => void;
  /** Optimistic rollback (-1, floored at 0). */
  decrement: () => void;
  /** Replace `count` with an authoritative value (e.g. from `commit`). */
  setCount: (_next: number) => void;
}

async function fetchCurrentCount(): Promise<number> {
  try {
    const insights = await practiceSessions.insights();
    const buckets = insights.weekly_counts;
    if (buckets.length > 0) {
      // The backend rolls up Monday-anchored buckets in ascending order; the
      // current week is the last entry. An empty `weekly_counts` array means
      // no sessions in the lookback window — fall through to the legacy
      // endpoint, which is the simplest way to confirm "still zero".
      const latest = buckets[buckets.length - 1];
      if (latest) return latest.count;
    }
    return 0;
  } catch {
    const legacy = await practiceSessions.weekCount();
    return legacy.count;
  }
}

export function useWeeklyProgress(): UseWeeklyProgressResult {
  const [count, setCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useMountedRef();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchCurrentCount();
      if (!mountedRef.current) return;
      setCount(next);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(toError(err));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [mountedRef]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const increment = useCallback(() => {
    setCount((prev) => prev + 1);
  }, []);

  const decrement = useCallback(() => {
    setCount((prev) => Math.max(0, prev - 1));
  }, []);

  return {
    count,
    isLoading,
    error,
    refresh,
    increment,
    decrement,
    setCount,
  };
}
