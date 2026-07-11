/**
 * Offset-paged journal fetch shared by the shelf list and the header drawer.
 *
 * Owns the entry page state (items / total / hasMore / loading / error) and a
 * single ``load`` that either replaces (offset 0) or appends (offset > 0). A
 * request-sequence guard drops every response but the newest, so overlapping
 * loads never race and a stale page never clobbers a fresher one.
 */
import { useCallback, useRef, useState } from 'react';

import { journal } from '@/api';
import type { JournalMessage } from '@/api';
import { formatApiError } from '@/api/errorMessages';

/** Entries fetched per page; also the offset step for "load more". */
export const PAGE_SIZE = 20;

export interface PagedJournal {
  items: JournalMessage[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** Fetch ``offset``'s page: offset 0 replaces the list, otherwise appends. */
  load: (_search: string | undefined, _offset: number) => Promise<void>;
}

/** Offset-paged fetch with a stale-response guard; the caller layers intent on top. */
export function usePagedJournal(): PagedJournal {
  const [items, setItems] = useState<JournalMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async (search: string | undefined, offset: number) => {
    // Only the newest in-flight request may settle; stale ones are dropped.
    const requestId = (requestSeq.current += 1);
    const isLatest = () => requestId === requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await journal.list({ search, limit: PAGE_SIZE, offset });
      if (!isLatest()) return;
      setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
      setTotal(page.total);
      setHasMore(page.has_more);
    } catch (err) {
      // Surface the failure so a cold-start network error isn't mistaken for an
      // empty list; the current items (if any) stay in place for retry.
      if (isLatest()) setError(formatApiError(err));
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, []);

  return { items, total, hasMore, loading, error, load };
}
