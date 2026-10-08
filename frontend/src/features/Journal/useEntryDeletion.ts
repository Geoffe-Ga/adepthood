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
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import {
  WITHDRAWAL_PENDING_LOCATIONS,
  deleteEntryFailureNotice,
  erasureReceiptNotice,
} from './deleteEntryCopy';
import { optimisticRemove } from './optimisticRemove';

import { journal } from '@/api';
import type { CopyLocation, JournalMessage } from '@/api';

/** HTTP status a delete answers for a page that is already gone. */
const HTTP_NOT_FOUND = 404;

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
  /**
   * A refused delete whose page is safe here but whose vault copy is not
   * confirmed gone (#3094): the reconnect-first / "I can't reach it" choice.
   * Null while there is no such choice to make.
   */
  unreachable: UnreachableCopy | null;
  /** Step away from the choice (for instance, to go and reconnect the vault). */
  dismissUnreachable: () => void;
  /** "I can't reach it": delete the page here only, and say plainly what remains. */
  eraseHere: () => void;
  /** The plain receipt after deleting here only; null otherwise. */
  receipt: string | null;
}

export interface UnreachableCopy {
  entry: JournalMessage;
  location: CopyLocation;
}

/** True for the 404 a delete answers once the page is already gone. */
function isAlreadyDeleted(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, detail } = error as { status?: unknown; detail?: unknown };
  return status === HTTP_NOT_FOUND && detail === 'journal_entry_not_found';
}

/** The location a withdrawal 503 names, or null for any other failure. */
function withdrawalLocation(error: unknown): CopyLocation | null {
  if (typeof error !== 'object' || error === null) return null;
  const { detail } = error as { detail?: unknown };
  if (typeof detail !== 'string') return null;
  if (!Object.hasOwn(WITHDRAWAL_PENDING_LOCATIONS, detail)) return null;
  return WITHDRAWAL_PENDING_LOCATIONS[detail] ?? null;
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

/** The state setters and refs one delete (ordinary or "here only") works through. */
interface RemovalContext {
  setUnreachable: Dispatch<SetStateAction<UnreachableCopy | null>>;
  setReceipt: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  inFlightRef: MutableRefObject<Set<number>>;
  itemsRef: MutableRefObject<readonly JournalMessage[]>;
  setItems: Dispatch<SetStateAction<JournalMessage[]>>;
  adjustTotal: (_delta: number) => void;
}

/**
 * The ordinary delete. A withdrawal 503 also opens the reconnect-first /
 * "I can't reach it" choice for that page (#3094), beside the usual notice.
 */
function deleteWithChoice(target: JournalMessage, ctx: RemovalContext): void {
  let location: CopyLocation | null = null;
  void optimisticRemove(target.id, {
    pendingIds: ctx.inFlightRef.current,
    current: ctx.itemsRef.current,
    setItems: ctx.setItems,
    removeRemote: (entryId) =>
      journal.delete(entryId).catch((err: unknown) => {
        // A retry of a delete the background sweep already finished: the page
        // is gone, which is what was asked for, so it is not a refusal (#3098).
        if (isAlreadyDeleted(err)) return;
        location = withdrawalLocation(err);
        throw err;
      }),
    reinsert: reinsertNewestFirst,
    onError: (detail) => {
      ctx.adjustTotal(1);
      // A withdrawal 503 means the deletion is recorded and finishes on its
      // own once the vault confirms; say that, not that the delete failed.
      ctx.setError(location === null ? deleteEntryFailureNotice(detail) : detail);
      if (location !== null) ctx.setUnreachable({ entry: target, location });
    },
    beforeStart: () => {
      ctx.setError(null);
      ctx.setReceipt(null);
      ctx.setUnreachable(null);
      ctx.adjustTotal(-1);
    },
  });
}

/**
 * "I can't reach it" (#3094): delete the page here only, with the same
 * optimistic-with-revert rhythm as an ordinary delete, and keep the server's
 * receipt so the shelf can say plainly what may remain in the vault.
 */
function eraseHereOnly(choice: UnreachableCopy, ctx: RemovalContext): void {
  ctx.setUnreachable(null);
  void optimisticRemove(choice.entry.id, {
    pendingIds: ctx.inFlightRef.current,
    current: ctx.itemsRef.current,
    setItems: ctx.setItems,
    removeRemote: async (entryId) => {
      ctx.setReceipt(erasureReceiptNotice(await journal.eraseLocally(entryId)));
    },
    reinsert: reinsertNewestFirst,
    onError: (detail) => {
      ctx.adjustTotal(1);
      ctx.setError(deleteEntryFailureNotice(detail));
    },
    beforeStart: () => {
      ctx.setError(null);
      ctx.adjustTotal(-1);
    },
  });
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

  const [unreachable, setUnreachable] = useState<UnreachableCopy | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const ctx = useMemo<RemovalContext>(
    () => ({ setUnreachable, setReceipt, setError, inFlightRef, itemsRef, setItems, adjustTotal }),
    [setItems, adjustTotal],
  );
  const confirm = useCallback(() => {
    if (pending === null) return;
    setPending(null);
    deleteWithChoice(pending, ctx);
  }, [pending, ctx]);
  const dismissUnreachable = useCallback(() => setUnreachable(null), []);
  const eraseHere = useCallback(() => {
    if (unreachable !== null) eraseHereOnly(unreachable, ctx);
  }, [unreachable, ctx]);

  return {
    pending,
    error,
    isRemoving,
    request,
    cancel,
    confirm,
    unreachable,
    dismissUnreachable,
    eraseHere,
    receipt,
  };
}
