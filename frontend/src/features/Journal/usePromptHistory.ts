/**
 * ``usePromptHistory`` — paged reader for the weekly prompts a person has
 * already answered (``GET /prompts/history``).
 *
 * The shelf's prompt card only ever shows the *current* unanswered question, so
 * without this the questions themselves are unreadable once answered: the
 * response is mirrored into the journal stream, but the question that drew it
 * is not. Fetching starts only when the surface is opened, so a shelf render
 * costs nothing extra.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { prompts } from '@/api';
import type { PromptDetail } from '@/api';
import { formatApiError } from '@/api/errorMessages';

/** Rows per request; the route caps ``limit`` at 200. */
export const PROMPT_HISTORY_PAGE_SIZE = 20;

export interface PromptHistoryState {
  items: PromptDetail[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
}

export function usePromptHistory(
  visible: boolean,
  fetchHistory: typeof prompts.history,
): PromptHistoryState {
  const [items, setItems] = useState<PromptDetail[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a page landing after the surface closed or unmounted.
  const live = useRef(false);

  const loadPage = useCallback(
    async (offset: number): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await fetchHistory({ limit: PROMPT_HISTORY_PAGE_SIZE, offset });
        if (!live.current) return;
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setHasMore(page.has_more);
      } catch (err: unknown) {
        if (live.current) {
          setError(formatApiError(err, { fallback: 'Could not load your past prompts.' }));
        }
      } finally {
        if (live.current) setLoading(false);
      }
    },
    [fetchHistory],
  );

  useEffect(() => {
    if (!visible) return undefined;
    live.current = true;
    setItems([]);
    setHasMore(false);
    void loadPage(0);
    return () => {
      live.current = false;
    };
  }, [visible, loadPage]);

  const loadMore = useCallback(() => {
    if (loading) return;
    void loadPage(items.length);
  }, [loading, loadPage, items.length]);

  return { items, loading, error, hasMore, loadMore };
}
