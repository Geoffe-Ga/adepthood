import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

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
  /** Ask for the next page; after a failure, ask again for the page that failed. */
  loadMore: () => void;
  /** Ask again for the page that failed, same filter and offset (the inbox's Try again). */
  retry: () => void;
  /** Re-read from the top, replacing the list (the refresh after a triage change lands). */
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

type PagingActions = Pick<FeedbackInboxState, 'loadMore' | 'retry' | 'reload'>;

/**
 * The three ways the inbox moves its page window. While ``failed`` holds, the
 * request's offset is still the one that failed, so Load more and Try again
 * both ask for it again rather than stepping past it.
 */
function usePagingActions(
  setPageRequest: Dispatch<SetStateAction<PageRequest>>,
  failed: boolean,
): PagingActions {
  const loadMore = useCallback(
    () =>
      setPageRequest((current) => ({
        ...current,
        offset: failed ? current.offset : current.offset + INBOX_PAGE_SIZE,
      })),
    [setPageRequest, failed],
  );
  // A fresh object re-runs the effect for the same filter and offset.
  const retry = useCallback(() => setPageRequest((current) => ({ ...current })), [setPageRequest]);
  const reload = useCallback(
    () => setPageRequest((current) => ({ filters: current.filters, offset: 0 })),
    [setPageRequest],
  );
  return { loadMore, retry, reload };
}

/**
 * The inbox list: newest first, filtered by status, paged by the server.
 *
 * Paging appends rather than replaces, and only ever asks for the next offset
 * the server's own ``has_more`` promised, so the list is the union of pages the
 * server's total order produced -- no row twice, none skipped. Changing the
 * filter restarts paging in the same update, so each filter is fetched once.
 *
 * A page that fails is asked for again at its own offset -- by Try again
 * (``retry``) or by Load more -- and never skipped; the rows already shown stay
 * shown meanwhile (#2996). ``reload`` is different on purpose: it re-reads from
 * the top, for the refresh after a triage change lands.
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

  const { loadMore, retry, reload } = usePagingActions(setPageRequest, failed);

  return { items, total, hasMore, loading, failed, status, setStatus, loadMore, retry, reload };
}
