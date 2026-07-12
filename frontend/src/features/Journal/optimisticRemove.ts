/**
 * ``optimisticRemove`` — the shared guarded optimistic-remove-with-revert
 * primitive for Journal lists. Guards a double in-flight tap per id, drops the
 * row up front, and re-inserts it (via the caller's ``reinsert``) if the remote
 * delete rejects. The optional ``beforeStart`` hook lets a caller clear a hint
 * before mutating; it runs exactly once, before the optimistic removal.
 */
import type { Dispatch, SetStateAction } from 'react';

import { formatApiError } from '@/api/errorMessages';

export interface OptimisticRemoveDeps<T extends { id: number }> {
  pendingIds: Set<number>;
  current: readonly T[];
  setItems: Dispatch<SetStateAction<T[]>>;
  removeRemote: (_id: number) => Promise<unknown>;
  reinsert: (_prev: T[], _item: T) => T[];
  onError: (_message: string) => void;
  beforeStart?: () => void;
}

export async function optimisticRemove<T extends { id: number }>(
  id: number,
  deps: OptimisticRemoveDeps<T>,
): Promise<void> {
  if (deps.pendingIds.has(id)) return; // per-id guard
  deps.pendingIds.add(id);
  deps.beforeStart?.();
  const removed = deps.current.find((row) => row.id === id);
  deps.setItems((prev) => prev.filter((row) => row.id !== id)); // optimistic remove
  try {
    await deps.removeRemote(id);
  } catch (err) {
    if (removed) deps.setItems((prev) => deps.reinsert(prev, removed)); // revert
    deps.onError(formatApiError(err));
  } finally {
    deps.pendingIds.delete(id);
  }
}
