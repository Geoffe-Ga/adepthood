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

/**
 * Which row wins when a loaded snapshot and the current in-memory list collide
 * on an id. ``'prev'`` keeps the in-memory row — the right call for marginalia
 * and suggestions, where an accepted flip or an essay-bearing note must outrank
 * a plain re-fetch. ``'snapshot'`` keeps the freshly fetched row — the right
 * call for promotions, whose reopened server copy is the canonical one. Each
 * hook injects its own choice; the scaffolding stays behaviour-neutral.
 */
export type CollisionWinner = 'prev' | 'snapshot';

/** The behaviour-neutral default: the in-memory list wins an id collision. */
const DEFAULT_WINNER: CollisionWinner = 'prev';

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
 * it. With the default ``'prev'`` winner the in-memory rows win an id collision
 * (so a slow load can't clobber an optimistic add, accepted flip, or
 * essay-bearing note); with ``'snapshot'`` the fetched rows win (promotions,
 * whose reopened server copy is canonical). Named at module scope (not an inline
 * updater) so the hydration effect stays flat and within the nested-callback
 * budget.
 */
export function mergeSnapshotUnder<T extends AnchoredRow>(
  snapshot: T[],
  compare: (_a: T, _b: T) => number = byAnchorStart,
  winner: CollisionWinner = DEFAULT_WINNER,
): (_prev: T[]) => T[] {
  // ``mergeByIdSorted`` lets the second (incoming) list win a collision, so the
  // winning side is passed second: prev for ``'prev'``, snapshot for ``'snapshot'``.
  return (prev) =>
    winner === 'snapshot'
      ? mergeByIdSorted(prev, snapshot, compare)
      : mergeByIdSorted(snapshot, prev, compare);
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
 * failed load, else it stays silent. ``winner`` picks who wins an id collision
 * between the snapshot and current state (see {@link CollisionWinner}).
 */
export function useHydrateOnOpen<T extends AnchoredRow>(
  entryId: number | null,
  load: (_id: number) => Promise<{ items: T[] }>,
  apply: Dispatch<SetStateAction<T[]>>,
  compare: (_a: T, _b: T) => number = byAnchorStart,
  onError?: (_message: string) => void,
  winner: CollisionWinner = DEFAULT_WINNER,
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
        if (active) apply(mergeSnapshotUnder(res.items, compare, winner));
      })
      .catch((err) => {
        if (active && onError) onError(formatApiError(err));
      });
    return () => {
      active = false;
    };
  }, [entryId, load, apply, compare, onError, winner]);
}
