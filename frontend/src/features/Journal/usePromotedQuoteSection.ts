/**
 * ``usePromotedQuoteSection`` — one section of the Promoted quotes screen
 * (#2865): its pages of ``GET /promotions?status=…``, and the optimistic remove
 * that edits them.
 *
 * Paging is offset-based, so the optimistic remove is the dangerous neighbour:
 * while a DELETE is in flight the list is one row shorter than the server's, so
 * ``items.length`` is not the server offset of the next page. Paging therefore
 * waits for every remove to settle. And a reload that lands inside a remove
 * replaces the rows and total the remove's relative adjustments were made
 * against, so once such a remove settles the section re-reads rather than
 * trusting those deltas. Pages are also de-duplicated by id as a backstop for
 * rows another device added between reads.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { optimisticRemove } from './optimisticRemove';

import { promotions, type PromotedQuoteListItem, type PromotionStatusFilter } from '@/api';
import { formatApiError } from '@/api/errorMessages';

/** How many quotes each section reads per page (the server's default page). */
export const PROMOTED_QUOTES_PAGE_SIZE = 50;

export type SectionStatus = Extract<PromotionStatusFilter, 'pending' | 'included'>;

interface SectionState {
  items: PromotedQuoteListItem[];
  total: number;
  loading: boolean;
  /** Null until a read fails; holds the sentence the reader is shown. */
  error: string | null;
  /** The offset of the read that failed, so a retry asks for that page again. */
  failedOffset: number | null;
  hasMore: boolean;
  /** False until the first read settles, so an empty section is never shown early. */
  settled: boolean;
  /** Removes whose DELETE has not settled; paging waits for them. */
  removing: number;
}

const INITIAL_SECTION: SectionState = {
  items: [],
  total: 0,
  loading: true,
  error: null,
  failedOffset: null,
  hasMore: false,
  settled: false,
  removing: 0,
};

/** What a remove reports back to the screen. */
export interface RemoveHandlers {
  onStart: () => void;
  onError: (_message: string) => void;
}

export interface QuoteSection extends SectionState {
  status: SectionStatus;
  /** Fetch the next page; a no-op while one is in flight or a remove is pending. */
  loadMore: () => void;
  /** Re-read from the top, abandoning any read in flight. */
  reload: () => void;
  /** Ask again for whatever failed: the older page, or the section from the top. */
  retry: () => void;
  /** Remove a quote optimistically, reverting (or reconciling) when it settles. */
  remove: (_id: number, _handlers: RemoveHandlers) => Promise<void>;
}

/** ``created_at`` desc, then ``id`` desc -- the server's own order. */
function newerFirst(a: PromotedQuoteListItem, b: PromotedQuoteListItem): number {
  return b.created_at.localeCompare(a.created_at) || b.id - a.id;
}

/**
 * Put a quote back where the server's order places it, for the revert of a
 * failed remove. A quote already present is left alone, never duplicated.
 */
export function reinsertByCreatedDesc(
  items: PromotedQuoteListItem[],
  quote: PromotedQuoteListItem,
): PromotedQuoteListItem[] {
  if (items.some((row) => row.id === quote.id)) return items;
  const at = items.findIndex((row) => newerFirst(quote, row) < 0);
  return at === -1 ? [...items, quote] : [...items.slice(0, at), quote, ...items.slice(at)];
}

/** Append a page, dropping any row already on screen. */
function appendUnseen(
  items: PromotedQuoteListItem[],
  page: PromotedQuoteListItem[],
): PromotedQuoteListItem[] {
  const seen = new Set(items.map((row) => row.id));
  return [...items, ...page.filter((row) => !seen.has(row.id))];
}

/** Updater landing one page: the first replaces the section, a later one appends. */
function pageLanded(
  page: { items: PromotedQuoteListItem[]; total: number; has_more: boolean },
  offset: number,
) {
  return (previous: SectionState): SectionState => ({
    ...previous,
    items: offset === 0 ? page.items : appendUnseen(previous.items, page.items),
    total: page.total,
    loading: false,
    error: null,
    failedOffset: null,
    hasMore: page.has_more,
    settled: true,
  });
}

/** Updater recording a failed read without discarding what was already read. */
function readFailed(error: string, offset: number) {
  return (previous: SectionState): SectionState => ({
    ...previous,
    loading: false,
    error,
    failedOffset: offset,
    settled: true,
  });
}

/** Read one section's pages; a generation counter drops a page a reload overtook. */
function useSectionReader(status: SectionStatus) {
  const [state, setState] = useState<SectionState>(INITIAL_SECTION);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const read = useCallback(
    (offset: number) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const mine = generation.current;
      setState((previous) => ({ ...previous, loading: true, error: null }));
      promotions
        .listAll({ status, limit: PROMOTED_QUOTES_PAGE_SIZE, offset })
        .then((page) => {
          if (mine === generation.current) setState(pageLanded(page, offset));
        })
        .catch((failure: unknown) => {
          if (mine === generation.current) setState(readFailed(formatApiError(failure), offset));
        })
        .finally(() => {
          if (mine === generation.current) inFlight.current = false;
        });
    },
    [status],
  );

  const reload = useCallback(() => {
    generation.current += 1;
    inFlight.current = false;
    read(0);
  }, [read]);

  return { state, setState, read, reload, generation };
}

/**
 * The optimistic remove for one section.
 *
 * The row and one from the total leave at once. When the DELETE settles, the
 * relative revert (a refused remove puts the row and the count back) is only
 * applied if no reload landed meanwhile; if one did, the rows and total it
 * brought already disagree with the deltas, so the section re-reads instead.
 */
function useSectionRemove(reader: ReturnType<typeof useSectionReader>): QuoteSection['remove'] {
  const { setState, reload, generation } = reader;
  const pendingIds = useRef(new Set<number>()).current;
  const items = reader.state.items;

  return useCallback(
    async (id: number, handlers: RemoveHandlers) => {
      const startedIn = generation.current;
      const unchanged = (): boolean => generation.current === startedIn;
      setState((previous) => ({ ...previous, removing: previous.removing + 1 }));
      await optimisticRemove(id, {
        pendingIds,
        current: items,
        setItems: (next) => {
          if (!unchanged()) return;
          setState((previous) => ({
            ...previous,
            items: typeof next === 'function' ? next(previous.items) : next,
          }));
        },
        removeRemote: (quoteId) => promotions.remove(quoteId),
        reinsert: reinsertByCreatedDesc,
        beforeStart: () => {
          handlers.onStart();
          setState((previous) => ({ ...previous, total: previous.total - 1 }));
        },
        onError: (message) => {
          if (unchanged()) setState((previous) => ({ ...previous, total: previous.total + 1 }));
          handlers.onError(message);
        },
      });
      setState((previous) => ({ ...previous, removing: previous.removing - 1 }));
      if (!unchanged()) reload();
    },
    [generation, items, pendingIds, reload, setState],
  );
}

/** One section's pages, its paging and retry, and its optimistic remove. */
export function usePromotedQuoteSection(status: SectionStatus): QuoteSection {
  const reader = useSectionReader(status);
  const { state, read, reload } = reader;
  const remove = useSectionRemove(reader);

  useEffect(() => {
    read(0);
  }, [read]);

  const { hasMore, loading, items, removing, failedOffset } = state;
  const loadMore = useCallback(() => {
    if (hasMore && !loading && removing === 0) read(items.length);
  }, [hasMore, loading, removing, items.length, read]);
  const retry = useCallback(() => {
    if (failedOffset != null && failedOffset > 0) read(failedOffset);
    else reload();
  }, [failedOffset, read, reload]);

  return { ...state, status, loadMore, reload, retry, remove };
}
