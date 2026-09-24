import { useCallback, useEffect, useState } from 'react';

import {
  adminFeedback,
  type FeedbackInboxFilters,
  type FeedbackStatusT,
  type FeedbackTriageSummaryT,
} from '@/api';
import { useAuth } from '@/context/AuthContext';

/** Rows per page. Small enough to read at a glance, large enough to rarely page. */
export const INBOX_PAGE_SIZE = 25;

export interface FeedbackInboxState {
  items: FeedbackTriageSummaryT[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  status: FeedbackStatusT | undefined;
  setStatus: (_status: FeedbackStatusT | undefined) => void;
  loadMore: () => void;
  reload: () => void;
}

interface PageRequest {
  filters: FeedbackInboxFilters;
  offset: number;
}

/** A state updater: the first page replaces the list, a later page extends it. */
function appendPage(
  offset: number,
  incoming: FeedbackTriageSummaryT[],
): (_previous: FeedbackTriageSummaryT[]) => FeedbackTriageSummaryT[] {
  return (previous) => (offset === 0 ? incoming : [...previous, ...incoming]);
}

/**
 * The inbox list: newest first, filtered by status, paged by the server.
 *
 * Paging appends rather than replaces, and only ever asks for the next offset
 * the server's own ``has_more`` promised, so the list is the union of pages the
 * server's total order produced -- no row twice, none skipped. Changing the
 * filter restarts paging in the same update, so each filter is fetched once.
 */
export function useFeedbackInbox(): FeedbackInboxState {
  const { token } = useAuth();
  const [items, setItems] = useState<FeedbackTriageSummaryT[]>([]);
  const [{ total, hasMore }, setMeta] = useState({ total: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pageRequest, setPageRequest] = useState<PageRequest>({ filters: {}, offset: 0 });
  const status = pageRequest.filters.status;
  const setStatus = useCallback(
    (next: FeedbackStatusT | undefined) =>
      setPageRequest({ filters: next ? { status: next } : {}, offset: 0 }),
    [],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setFailed(false);
    adminFeedback
      .list(
        pageRequest.filters,
        { limit: INBOX_PAGE_SIZE, offset: pageRequest.offset },
        token ?? undefined,
      )
      .then((page) => {
        if (!live) return;
        setItems(appendPage(pageRequest.offset, page.items));
        setMeta({ total: page.total, hasMore: page.has_more });
      })
      .catch(() => {
        if (live) setFailed(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [pageRequest, token]);

  const loadMore = useCallback(
    () => setPageRequest((current) => ({ ...current, offset: current.offset + INBOX_PAGE_SIZE })),
    [],
  );
  const reload = useCallback(
    () => setPageRequest((current) => ({ filters: current.filters, offset: 0 })),
    [],
  );

  return { items, total, hasMore, loading, failed, status, setStatus, loadMore, reload };
}
