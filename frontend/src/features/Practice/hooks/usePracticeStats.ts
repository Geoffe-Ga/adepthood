/**
 * `usePracticeStats` — the practitioner's all-time investment in one catalog
 * practice: how many sittings, and how many minutes (#2449).
 *
 * Two steps, because the screen is keyed on a *catalog* practice while the
 * aggregate is keyed on an adoption the caller owns:
 *
 *   1. find one of the caller's `UserPractice` rows for this practice;
 *   2. ask the backend aggregate about it.
 *
 * Step 1 needs to find only *one* such row even when several exist: the server
 * widens from the row it is given to every adoption of the same practice the
 * caller owns, so a practice carried from stage 1 into stage 2 reports one
 * lifetime figure whichever of its rows is named. That is also why the totals
 * are never assembled here from `GET /practice-sessions/` — paging a lifetime
 * of rows to add them up would grow a request per page and would put the
 * counting rule in a second place, free to drift from the first.
 *
 * A practice the user has not adopted yields `stats: null` and issues no
 * aggregate request at all. Nothing has been invested in it, and browsing the
 * catalog is not an occasion to measure yourself against a practice you have
 * not chosen.
 *
 * The unmount guards follow the same convention as `useActivePractice` and
 * `useWeeklyProgress`. Only the first one has observable consequences -- it is
 * what stops the aggregate request from being issued on behalf of a screen that
 * is already gone, and its test kills the mutation that removes it. The ones
 * after the aggregate resolves are conventional rather than proven: React 18 no
 * longer warns on a state write into a torn-down instance, so nothing a test
 * can assert changes when they are dropped.
 *
 * Failures are silent by design. These totals are an aside on a screen whose
 * job is to describe a practice; a rollup that could not load must not put an
 * error banner over the description, so the block simply does not appear.
 */
import { useCallback, useEffect, useState } from 'react';

import { practiceSessions, userPractices, type PracticeStatsResponse } from '@/api';
import { useMountedRef } from '@/features/Practice/hooks/useMountedRef';

export interface UsePracticeStatsResult {
  stats: PracticeStatsResponse | null;
  isLoading: boolean;
}

export function usePracticeStats(practiceId: number): UsePracticeStatsResult {
  const [stats, setStats] = useState<PracticeStatsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useMountedRef();

  const load = useCallback(async () => {
    try {
      const adopted = await userPractices.list();
      const mine = adopted.find((row) => row.practice_id === practiceId);
      if (!mountedRef.current) return;
      if (mine === undefined) {
        setStats(null);
        return;
      }
      const totals = await practiceSessions.stats(mine.id);
      if (!mountedRef.current) return;
      setStats(totals);
    } catch {
      if (mountedRef.current) setStats(null);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [practiceId, mountedRef]);

  useEffect(() => {
    setIsLoading(true);
    void load();
  }, [load]);

  return { stats, isLoading };
}
