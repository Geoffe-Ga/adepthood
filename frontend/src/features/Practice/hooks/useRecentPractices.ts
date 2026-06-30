import { useCallback, useEffect, useState } from 'react';

import {
  MAX_RECENT_PRACTICES,
  loadRecentPractices,
  recordRecentPractice,
  type RecentPractice,
} from '@/storage/recentPracticesStorage';

interface RecentPracticesHook {
  recents: RecentPractice[];
  /** Record a freshly-begun practice — updates state optimistically, then persists. */
  record: (_entry: RecentPractice) => void;
}

/**
 * Reads (and records into) the persisted "recently begun practices" list. The
 * catalog uses it to surface a quick shortcut row above the full sections.
 */
export function useRecentPractices(): RecentPracticesHook {
  const [recents, setRecents] = useState<RecentPractice[]>([]);

  useEffect(() => {
    let active = true;
    void loadRecentPractices().then((list) => {
      if (active) setRecents(list);
    });
    return () => {
      active = false;
    };
  }, []);

  const record = useCallback((entry: RecentPractice) => {
    setRecents((prev) => mergeRecent(prev, entry));
    void recordRecentPractice(entry);
  }, []);

  return { recents, record };
}

/** Move ``entry`` to the front of ``prev`` (deduped by id), capped to the max. */
function mergeRecent(prev: readonly RecentPractice[], entry: RecentPractice): RecentPractice[] {
  const deduped = prev.filter((item) => item.id !== entry.id);
  return [entry, ...deduped].slice(0, MAX_RECENT_PRACTICES);
}
