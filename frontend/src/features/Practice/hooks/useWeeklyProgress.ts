/** The user-wide Glance retains /insights until its API retirement (#3530). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { practiceSessions, type PracticeInsightsResponse } from '@/api';
import { captureSessionToken, getAuthSession } from '@/api/sessionToken';
import { toError } from '@/features/Practice/utils/toError';
import { useMountedRef } from '@/hooks/useMountedRef';
import { useAccountScope } from '@/storage/useActiveUser';
import { parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

export interface UseWeeklyProgressResult {
  count: number;
  insights: PracticeInsightsResponse | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  increment: () => void;
  decrement: () => void;
  setCount: (_next: number) => void;
}
function useWeeklyContext() {
  const scope = useAccountScope();
  const token = captureSessionToken();
  const session = getAuthSession();
  return useMemo(
    () => ({ scope, token, session, key: `${scope.owner}:${scope.epoch}:${session}` }),
    [scope, token, session],
  );
}
type WeeklyContext = ReturnType<typeof useWeeklyContext>;
/** The owner stamp may update before its credential bridge. Both must agree. */
function canReadWeekly({ scope, token, session }: WeeklyContext): boolean {
  const liveToken = captureSessionToken();
  return (
    scope.owner !== null &&
    scope.isCurrent() &&
    getAuthSession() === session &&
    token !== undefined &&
    parseUserId(decodeJwtPayload(token)?.sub) === scope.owner &&
    liveToken !== undefined &&
    parseUserId(decodeJwtPayload(liveToken)?.sub) === scope.owner
  );
}
interface WeeklyState {
  key: string;
  count: number;
  insights: PracticeInsightsResponse | null;
  isLoading: boolean;
  error: Error | null;
}
async function fetchWeekly(context: WeeklyContext, current: () => boolean) {
  try {
    const insights = await practiceSessions.insights(context.token);
    return { count: insights.weekly_counts.at(-1)?.count ?? 0, insights };
  } catch {
    if (!current()) return null;
    const legacy = await practiceSessions.weekCount(context.token);
    return { count: legacy.count, insights: null };
  }
}
function emptyWeekly(key: string): WeeklyState {
  return { key, count: 0, insights: null, isLoading: true, error: null };
}
function useWeeklyRead(context: WeeklyContext) {
  const mounted = useMountedRef();
  const ticket = useRef(0);
  const [state, setState] = useState<WeeklyState>(() => emptyWeekly(context.key));
  const refresh = useCallback(async () => {
    if (!canReadWeekly(context)) return;
    const request = ++ticket.current;
    const current = () => mounted.current && canReadWeekly(context) && ticket.current === request;
    setState((previous) => ({
      ...emptyWeekly(context.key),
      count: previous.key === context.key ? previous.count : 0,
      insights: previous.key === context.key ? previous.insights : null,
    }));
    try {
      const next = await fetchWeekly(context, current);
      if (next !== null && current())
        setState({ key: context.key, ...next, isLoading: false, error: null });
    } catch (error) {
      if (current())
        setState({ ...emptyWeekly(context.key), isLoading: false, error: toError(error) });
    }
  }, [context, mounted]);
  return { state, setState, refresh };
}
export function useWeeklyProgress(): UseWeeklyProgressResult {
  const context = useWeeklyContext();
  const { state, setState, refresh } = useWeeklyRead(context);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const update = useCallback(
    (change: (_previous: number) => number) => {
      if (!canReadWeekly(context)) return;
      setState((previous) =>
        previous.key === context.key
          ? { ...previous, count: change(previous.count) }
          : { key: context.key, count: change(0), insights: null, error: null, isLoading: false },
      );
    },
    [context, setState],
  );
  const increment = useCallback(() => update((value) => value + 1), [update]);
  const decrement = useCallback(() => update((value) => Math.max(0, value - 1)), [update]);
  const setCount = useCallback((next: number) => update(() => next), [update]);
  const visible = state.key === context.key && canReadWeekly(context);
  return {
    count: visible ? state.count : 0,
    insights: visible ? state.insights : null,
    isLoading: visible ? state.isLoading : false,
    error: visible ? state.error : null,
    refresh,
    increment,
    decrement,
    setCount,
  };
}
