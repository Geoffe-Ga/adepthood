import { useCallback, useRef, useState } from 'react';

/**
 * Window a list into fixed-size pages. The setters never advance the internal
 * `page` above `pageCount - 1` (`goNext` caps it, `goLast` targets the last
 * content page, `goPrev` only decreases), so `goPrev`/`goNext` always step
 * relative to a valid index.
 * The read site additionally clamps `page` to guard the one case the setters
 * cannot: `habitCount` shrinking beneath the stored index without a setter call
 * (e.g. items are removed) — resolving it on the next read without an extra
 * render.
 *
 * When the last lap is completely full (`habitCount` is a positive exact
 * multiple of `pageSize`) the count grows by one trailing **invite page**: an
 * extra navigable empty page that lets the user start the next lap. `goNext`
 * can step onto it, but `goLast` deliberately does not — it retargets to the
 * last *content* page (the page holding the final item), so appending a new
 * item lands the user on the row they just created rather than the empty
 * invitation beyond it.
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
  const contentPages = Math.max(1, Math.ceil(habitCount / pageSize));
  const hasInvitePage = habitCount > 0 && habitCount % pageSize === 0;
  const pageCount = contentPages + (hasInvitePage ? 1 : 0);
  const [page, setPage] = useState(0);

  // Track the live count in a ref so `goLast` reads it at call time rather than
  // closing over a stale render. The add flow appends a habit and then calls
  // `goLast` from a callback captured before the append re-rendered; without
  // the ref that callback would target the pre-append last page and strand the
  // user on the wrong lap instead of the row they just created.
  const countRef = useRef(habitCount);
  countRef.current = habitCount;

  const goPrev = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);
  const goNext = useCallback(() => setPage((p) => Math.min(pageCount - 1, p + 1)), [pageCount]);
  const goLast = useCallback(
    () => setPage(Math.floor(Math.max(0, countRef.current - 1) / pageSize)),
    [pageSize],
  );

  return {
    page: Math.min(page, pageCount - 1),
    pageCount,
    goPrev,
    goNext,
    goLast,
  };
};

export default usePagination;
