/**
 * `useFrequency` — fetcher for the Practice frequency banner.
 *
 * Wraps `GET /user-practices/current/frequency` (ritual-05). The codebase
 * does not use React Query; this hook follows the same load-once / refetch
 * pattern as the existing `usePracticeListState` / `useLoadPracticeData`
 * pair in `PracticeScreen.tsx` so banner + screen share a mental model.
 *
 * The hook returns the *latest* settled state — when `refetch` is called it
 * does NOT reset `data` to `null` so the banner can keep showing the
 * previous payload while the spinner / dot-pulse plays. `error` IS cleared
 * on refetch because retaining a stale failure would lie about the state of
 * the new request.
 */
import { useCallback, useEffect, useState } from 'react';

import { frequency, type FrequencyResponse } from '@/api';
import { useMountedRef } from '@/features/Practice/hooks/useMountedRef';
import { toError } from '@/features/Practice/utils/toError';

export interface UseFrequencyResult {
  data: FrequencyResponse | null;
  isLoading: boolean;
  error: Error | null;
  /** Re-run the fetch. Resolves once the request settles (success or failure). */
  refetch: () => Promise<void>;
}

export function useFrequency(stageNumber?: number | null): UseFrequencyResult {
  const [data, setData] = useState<FrequencyResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useMountedRef();

  const fetchOnce = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await frequency.current(stageNumber);
      if (!mountedRef.current) return;
      setData(result);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(toError(err));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [stageNumber, mountedRef]);

  useEffect(() => {
    void fetchOnce();
  }, [fetchOnce]);

  return { data, isLoading, error, refetch: fetchOnce };
}
