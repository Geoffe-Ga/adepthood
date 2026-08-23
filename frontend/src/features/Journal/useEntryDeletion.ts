/**
 * ``useEntryDeletion`` — the ask, the delete, and the way back if it fails.
 *
 * Holds the entry waiting on a confirmation, then hands the confirmed one to
 * the Journal's shared ``optimisticRemove``: the row leaves the shelf at once
 * and comes back, in its own place, if the server refuses. That is the same
 * optimistic-with-revert shape the habits list already uses, so deleting a
 * page behaves like deleting a habit rather than inventing a third rhythm.
 *
 * Ownership is the server's business. ``DELETE /journal/{entry_id}`` resolves
 * the row through its owner check and collapses somebody else's entry to a
 * 404, so nothing here re-checks it — a client-side owner test would only
 * imply the server needed one.
 */
import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { deleteEntryFailureNotice } from './deleteEntryCopy';
import { optimisticRemove } from './optimisticRemove';

import { journal } from '@/api';
import type { JournalMessage } from '@/api';

export interface EntryDeletionDeps {
  items: readonly JournalMessage[];
  setItems: Dispatch<SetStateAction<JournalMessage[]>>;
  /** Move the reported total as a row leaves, and back if it returns. */
  adjustTotal: (_delta: number) => void;
}

export interface EntryDeletion {
  /** The entry whose delete is waiting on an answer, or null. */
  pending: JournalMessage | null;
  /** A refused delete, said in the shelf's own voice; null while all is well. */
  error: string | null;
  /**
   * Whether a confirmed delete is still waiting on the server. Read at the
   * moment a caller is about to replace the list wholesale: while this is true
   * the local list is deliberately ahead of the server, so a landing page would
   * put the removed row back — or undo a revert that had just restored it.
   *
   * A callback rather than a rendered flag so its identity is stable: the shelf
   * reads it from inside a focus effect that must fire once per focus, not once
   * per render.
   */
  isRemoving: () => boolean;
  request: (_entry: JournalMessage) => void;
  cancel: () => void;
  confirm: () => void;
}

/** Newest first, ties broken by id — the order the shelf list arrives in. */
function isOlder(row: JournalMessage, item: JournalMessage): boolean {
  const rowAt = Date.parse(row.timestamp);
  const itemAt = Date.parse(item.timestamp);
  if (rowAt !== itemAt) return rowAt < itemAt;
  return row.id < item.id;
}

/** Put a refused delete back where the shelf's newest-first order wants it. */
function reinsertNewestFirst(prev: JournalMessage[], item: JournalMessage): JournalMessage[] {
  const at = prev.findIndex((row) => isOlder(row, item));
  if (at < 0) return [...prev, item];
  return [...prev.slice(0, at), item, ...prev.slice(at)];
}

export function useEntryDeletion({
  items,
  setItems,
  adjustTotal,
}: EntryDeletionDeps): EntryDeletion {
  const [pending, setPending] = useState<JournalMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-id guard against a second delete for a row already in flight.
  const inFlightRef = useRef<Set<number>>(new Set());
  // Mirror the list so ``confirm`` can find the row it drops without taking a
  // dependency on ``items`` that would rebuild it on every page load.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const request = useCallback((target: JournalMessage) => setPending(target), []);
  const cancel = useCallback(() => setPending(null), []);
  const isRemoving = useCallback(() => inFlightRef.current.size > 0, []);

  const confirm = useCallback(() => {
    const target = pending;
    if (target === null) return;
    setPending(null);
    void optimisticRemove(target.id, {
      pendingIds: inFlightRef.current,
      current: itemsRef.current,
      setItems,
      removeRemote: (entryId) => journal.delete(entryId),
      reinsert: reinsertNewestFirst,
      onError: (detail) => {
        adjustTotal(1);
        setError(deleteEntryFailureNotice(detail));
      },
      beforeStart: () => {
        setError(null);
        adjustTotal(-1);
      },
    });
  }, [pending, setItems, adjustTotal]);

  return { pending, error, isRemoving, request, cancel, confirm };
}
