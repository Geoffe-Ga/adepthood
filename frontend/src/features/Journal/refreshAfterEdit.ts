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
  /** Arms the deferred refresh when the writer confirms an edit of a finished entry. */
  onConfirmEdit: () => void;
}

export function useRefreshAfterEdit(): RefreshAfterEdit {
  const refreshersRef = useRef<readonly Refresher[]>([]);
  const pendingRefreshRef = useRef(false);
  const handleSaved = useCallback(() => {
    if (!pendingRefreshRef.current) return;
    pendingRefreshRef.current = false;
    void Promise.allSettled(refreshersRef.current.map((refresh) => refresh()));
  }, []);
  const onConfirmEdit = useCallback(() => {
    pendingRefreshRef.current = true;
  }, []);
  return { refreshersRef, handleSaved, onConfirmEdit };
}
