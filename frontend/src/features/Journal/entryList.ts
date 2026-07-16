/**
 * ``entryList`` — the shared per-entry list scaffolding for the Journal hooks
 * (``useResonance`` and ``usePromotions``). Both hooks drive an anchor-sorted,
 * id-keyed list that is hydrated once when an entry opens and merged (never
 * blindly replaced) under any state that outran the load. That machinery lived
 * duplicated in both files; it lives here once.
 *
 * The two knobs that vary between the hooks are injected: the ``compare`` order
 * (anchor-only vs. an id tiebreak) and an optional ``onError`` sink (silent for
 * marginalia, a warm hint for promotions).
 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

import { formatApiError } from '@/api/errorMessages';

/** An anchored, id-keyed list row — the shared shape both hooks merge and sort. */
export interface AnchoredRow {
  id: number;
  anchor_start: number;
}

/** The sentinel id for an unsaved entry — nothing to hydrate until it has a real id. */
const UNSAVED_ENTRY_ID = 0;

/** Default order: by anchor offset alone (marginalia and suggestions). */
export function byAnchorStart<T extends { anchor_start: number }>(a: T, b: T): number {
  return a.anchor_start - b.anchor_start;
}

/** Union of two anchored lists, keyed by id (incoming wins), sorted by ``compare``. */
export function mergeByIdSorted<T extends AnchoredRow>(
  existing: T[],
  incoming: T[],
  compare: (_a: T, _b: T) => number = byAnchorStart,
): T[] {
  const byId = new Map<number, T>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort(compare);
}

/**
 * A state updater that folds a loaded ``snapshot`` under whatever state outran
 * it (server rows as existing, in-memory as incoming — so a slow load can't
 * clobber an optimistic add, accepted flip, or essay-bearing note). Named at
 * module scope (not an inline updater) so the hydration effect stays flat and
 * within the nested-callback budget.
 */
export function mergeSnapshotUnder<T extends AnchoredRow>(
  snapshot: T[],
  compare: (_a: T, _b: T) => number = byAnchorStart,
): (_prev: T[]) => T[] {
  return (prev) => mergeByIdSorted(snapshot, prev, compare);
}

/**
 * Hydrate a per-entry list once on open and merge (never replace) the snapshot
 * under current state. Skipped for a null/unsaved entry; the ``active`` flag
 * stops a slow response from setting state after unmount or an id change.
 *
 * On an entry *change* (not the first real load) the list resets to empty first,
 * so a prior entry's rows can't union into a new one while same-entry late loads
 * still merge under state. The first real load preserves any seeded state (e.g.
 * ``usePromotions``' ``initialQuotes``); ``onError`` (when given) reports a
 * failed load, else it stays silent.
 */
export function useHydrateOnOpen<T extends AnchoredRow>(
  entryId: number | null,
  load: (_id: number) => Promise<{ items: T[] }>,
  apply: Dispatch<SetStateAction<T[]>>,
  compare: (_a: T, _b: T) => number = byAnchorStart,
  onError?: (_message: string) => void,
): void {
  // True once a real entry has loaded, so the reset fires only on a subsequent
  // entry change — never on the first mount, which would wipe seeded state.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (entryId == null || entryId <= UNSAVED_ENTRY_ID) return undefined;
    if (loadedRef.current) apply([]);
    loadedRef.current = true;
    let active = true;
    void load(entryId)
      .then((res) => {
        if (active) apply(mergeSnapshotUnder(res.items, compare));
      })
      .catch((err) => {
        if (active && onError) onError(formatApiError(err));
      });
    return () => {
      active = false;
    };
  }, [entryId, load, apply, compare, onError]);
}
