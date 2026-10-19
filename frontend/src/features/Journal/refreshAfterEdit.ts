/**
 * ``useRefreshAfterEdit`` -- re-read what the server re-anchored after the
 * writer edits a finished entry.
 *
 * The first save after a confirmed edit is the PATCH that re-anchors the
 * entry's margin notes and pending promoted quotes (keeping each whose snapshot
 * text survives, marking the rest stale). The lists the screen holds still
 * carry the pre-edit offsets, so that save fires every registered refresher
 * once. ``onConfirmEdit`` arms it and the next ``handleSaved`` fires it.
 *
 * The refreshers settle independently (``Promise.allSettled``): a failed
 * marginalia re-read must not stop the quotes being re-read, and a rejection
 * must never escape as an unhandled promise.
 */
import { useCallback, useRef, type MutableRefObject } from 'react';

/** One list's re-read; the screen registers marginalia and promoted quotes. */
export type Refresher = () => Promise<void>;

export interface RefreshAfterEdit {
  /** The refreshers to fire, assigned by the caller on every render. */
  refreshersRef: MutableRefObject<readonly Refresher[]>;
  /** Fires the deferred refreshers after the first post-edit save. */
  handleSaved: () => void;
  /** Re-reads annotations after any write that can re-anchor them. */
  refreshNow: () => void;
  /** Arms the deferred refresh when the writer confirms an edit of a finished entry. */
  onConfirmEdit: () => void;
}

export function useRefreshAfterEdit(): RefreshAfterEdit {
  const refreshersRef = useRef<readonly Refresher[]>([]);
  const pendingRefreshRef = useRef(false);
  const refreshTailRef = useRef<Promise<void> | null>(null);
  const refreshNow = useCallback(() => {
    const refreshers = refreshersRef.current;
    const run = (): Promise<void> =>
      Promise.allSettled(refreshers.map((refresh) => refresh())).then(() => undefined);
    const batch = refreshTailRef.current == null ? run() : refreshTailRef.current.then(run);
    refreshTailRef.current = batch;
    void batch.finally(() => {
      if (refreshTailRef.current === batch) refreshTailRef.current = null;
    });
  }, []);
  const handleSaved = useCallback(() => {
    if (!pendingRefreshRef.current) return;
    pendingRefreshRef.current = false;
    refreshNow();
  }, [refreshNow]);
  const onConfirmEdit = useCallback(() => {
    pendingRefreshRef.current = true;
  }, []);
  return { refreshersRef, handleSaved, refreshNow, onConfirmEdit };
}
