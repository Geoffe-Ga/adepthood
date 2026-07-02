import { useCallback, useState } from 'react';

/**
 * Window a list into fixed-size pages. The setters never advance the internal
 * `page` above `pageCount - 1` (`goNext` caps it, `goLast` targets it, `goPrev`
 * only decreases), so `goPrev`/`goNext` always step relative to a valid index.
 * The read site additionally clamps `page` to guard the one case the setters
 * cannot: `habitCount` shrinking beneath the stored index without a setter call
 * (e.g. items are removed) — resolving it on the next read without an extra
 * render.
 *
 * `goLast` jumps to the true last page (`pageCount - 1`). Use it after
 * appending a new item so the user lands on the page that contains it.
 */
export interface PaginationState {
  /** Clamped current page (0-based). */
  page: number;
  /** Number of pages (always >= 1). */
  pageCount: number;
  goPrev: () => void;
  goNext: () => void;
  goLast: () => void;
}

export const usePagination = (habitCount: number, pageSize: number): PaginationState => {
  const pageCount = Math.max(1, Math.ceil(habitCount / pageSize));
  const [page, setPage] = useState(0);

  const goPrev = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);
  const goNext = useCallback(() => setPage((p) => Math.min(pageCount - 1, p + 1)), [pageCount]);
  const goLast = useCallback(() => setPage(pageCount - 1), [pageCount]);

  return {
    page: Math.min(page, pageCount - 1),
    pageCount,
    goPrev,
    goNext,
    goLast,
  };
};

export default usePagination;
