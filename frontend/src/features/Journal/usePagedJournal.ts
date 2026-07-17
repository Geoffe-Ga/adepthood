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
  /**
   * Fetch and append every remaining page in sequence, starting at
   * ``startOffset``. Each page's items extend the list; ``offset`` advances by
   * the number of items that page returned (tracked in a local, since React
   * state is stale within the loop) and the loop stops the moment a page reports
   * ``has_more: false`` or returns zero items (an infinite-loop guard).
   *
   * Shares ``load``'s stale-response guard: one request id covers the whole
   * sweep, so a newer ``load`` or ``loadAll`` cancels every unsettled page here.
   */
  loadAll: (_startOffset: number) => Promise<void>;
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

  const loadAll = useCallback(async (startOffset: number) => {
    // One request id for the whole sweep; drop it wholesale once superseded.
    const requestId = (requestSeq.current += 1);
    const isLatest = () => requestId === requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      // Track offset/more locally: the setState calls below won't be visible to
      // this closure until the next render, so reading them here would loop stale.
      let offset = startOffset;
      let more = true;
      while (more) {
        const page = await journal.list({ limit: PAGE_SIZE, offset });
        if (!isLatest()) return;
        setItems((prev) => [...prev, ...page.items]);
        setTotal(page.total);
        setHasMore(page.has_more);
        offset += page.items.length;
        // Stop on the last page or a zero-length page so we never spin forever.
        more = page.has_more && page.items.length > 0;
      }
    } catch (err) {
      if (isLatest()) setError(formatApiError(err));
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, []);

  return { items, total, hasMore, loading, error, load, loadAll };
}
