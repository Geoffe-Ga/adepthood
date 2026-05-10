import { useCallback, useState } from 'react';

/**
 * Window a list into fixed-size pages. Returns a clamped `page` so callers
 * always read a valid index even when `habitCount` shrinks beneath the
 * current internal state — that's the reason there is no corrective effect:
 * the clamp at the read site is sufficient and avoids an extra render.
 *
 * `goLast` sets internal state to `habitCount`, which is always above
 * `pageCount - 1`; the clamp resolves it to the actual last page on the next
 * read. Use this after appending a new item so the user lands on the page
 * that contains it.
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
  const goLast = useCallback(() => setPage(habitCount), [habitCount]);

  return {
    page: Math.min(page, pageCount - 1),
    pageCount,
    goPrev,
    goNext,
    goLast,
  };
};

export default usePagination;
