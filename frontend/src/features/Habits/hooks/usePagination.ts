import { useCallback, useRef, useState } from 'react';

/**
 * Window habits into fixed-size **signed** pages. Non-negative pages hold the
 * program habits (page 0 is stages 1..pageSize); negative pages hold the
 * carryover habits that predate the program, sitting before page 0. The
 * setters clamp to `[minPage, maxPage]`, and the read site additionally clamps
 * `page` to guard the one case the setters cannot: a count shrinking beneath
 * the stored index without a setter call — resolving it on the next read
 * without an extra render.
 *
 * When the last program lap is completely full (`programCount` is a positive
 * exact multiple of `pageSize`) `maxPage` grows by one trailing **invite
 * page**: an extra navigable empty page that lets the user start the next lap.
 * The negative side mirrors this with a **leading invite** that is always
 * available once any habit exists: with no carryover yet it is the single
 * empty lap -1, and each exactly-full carryover lap opens one deeper empty
 * negative lap. `goNext` can step onto the trailing invite, but `goLast`
 * deliberately does not — it retargets to the last program *content* page
 * (the page holding the final item), so appending a new habit lands the user
 * on the row they just created rather than the empty invitation beyond it;
 * `goFirstCarryover` is its negative mirror, targeting the lap that holds the
 * newest carryover habit.
 */
export interface PaginationState {
  /** Clamped current page (signed; 0 is the first program page). */
  page: number;
  /** Total navigable pages, negative laps included (always >= 1). */
  pageCount: number;
  /**
   * Deepest navigable negative lap, always-available leading invite included
   * (0 only when there are no habits at all).
   */
  minPage: number;
  /** Last navigable positive page, trailing invite included. */
  maxPage: number;
  /** Whether `goPrev` can still step down. */
  canPrev: boolean;
  /** Whether `goNext` can still step up. */
  canNext: boolean;
  goPrev: () => void;
  goNext: () => void;
  goLast: () => void;
  /** Jump to the negative lap holding the newest carryover habit. */
  goFirstCarryover: () => void;
}

/** Zero-based lap index of the page holding a list's newest (last) item. */
const lastContentLap = (count: number, pageSize: number): number =>
  Math.floor(Math.max(0, count - 1) / pageSize);

export const usePagination = (
  programCount: number,
  pageSize: number,
  carryoverCount = 0,
): PaginationState => {
  const contentPages = Math.max(1, Math.ceil(programCount / pageSize));
  const hasTrailingInvite = programCount > 0 && programCount % pageSize === 0;
  const maxPage = contentPages - 1 + (hasTrailingInvite ? 1 : 0);

  const negContentLaps = carryoverCount > 0 ? Math.ceil(carryoverCount / pageSize) : 0;
  // The leading invite is permanent once any habit exists: with zero carryover
  // it is the single empty lap -1, and each exactly-full carryover lap opens
  // one deeper empty lap (the negative mirror of the trailing invite).
  const hasLeadingInvite =
    (programCount > 0 || carryoverCount > 0) && carryoverCount % pageSize === 0;
  const negLaps = negContentLaps + (hasLeadingInvite ? 1 : 0);
  // Guard against negating zero: `-0` fails `Object.is`/`toBe(0)` equality.
  const minPage = negLaps === 0 ? 0 : -negLaps;

  const pageCount = maxPage - minPage + 1;
  const [page, setPage] = useState(0);

  // Track the live counts in refs so `goLast`/`goFirstCarryover` read them at
  // call time rather than closing over a stale render. The add flow appends a
  // habit and then calls the jump from a callback captured before the append
  // re-rendered; without the refs that callback would target the pre-append
  // lap and strand the user away from the row they just created.
  const countRef = useRef(programCount);
  countRef.current = programCount;
  const carryoverCountRef = useRef(carryoverCount);
  carryoverCountRef.current = carryoverCount;

  const goPrev = useCallback(() => setPage((p) => Math.max(minPage, p - 1)), [minPage]);
  const goNext = useCallback(() => setPage((p) => Math.min(maxPage, p + 1)), [maxPage]);
  const goLast = useCallback(() => setPage(lastContentLap(countRef.current, pageSize)), [pageSize]);
  // Negative page for carryover lap N is -(N + 1); at zero carryover this
  // yields -1, the always-available empty leading-invite lap.
  const goFirstCarryover = useCallback(
    () => setPage(-(lastContentLap(carryoverCountRef.current, pageSize) + 1)),
    [pageSize],
  );

  const clampedPage = Math.min(Math.max(page, minPage), maxPage);
  return {
    page: clampedPage,
    pageCount,
    minPage,
    maxPage,
    canPrev: clampedPage > minPage,
    canNext: clampedPage < maxPage,
    goPrev,
    goNext,
    goLast,
    goFirstCarryover,
  };
};

export default usePagination;
