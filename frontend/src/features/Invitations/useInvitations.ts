/**
 * ``useInvitations`` — loads the pending invitation surface on mount and decays
 * it one tap at a time.
 *
 * Silent by default: an empty list is the common, un-nagging case. ``dismiss``
 * removes the row optimistically, calls ``invitations.dismiss`` (idempotent),
 * and reverts on error. A per-id guard prevents a double-tap from double-firing,
 * and an unmount guard keeps late resolutions from setting state on a dead hook.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { invitations } from '@/api';
import type { Invitation } from '@/api';

export interface UseInvitationsResult {
  invitations: Invitation[];
  dismiss: (_id: number) => Promise<void>;
}

/** Return the list without the invitation carrying ``id`` (order-preserving). */
function withoutId(list: Invitation[], id: number): Invitation[] {
  return list.filter((invitation) => invitation.id !== id);
}

export function useInvitations(): UseInvitationsResult {
  const [items, setItems] = useState<Invitation[]>([]);
  const itemsRef = useRef<Invitation[]>([]);
  const pendingIdsRef = useRef<Set<number>>(new Set());
  const mountedRef = useRef(true);

  // Mirror committed state into a ref so ``dismiss`` can snapshot it
  // synchronously — a functional-updater side-effect runs at render time,
  // too late for the revert branch when the API rejects immediately.
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    mountedRef.current = true;
    void invitations
      .list()
      .then((loaded) => {
        if (mountedRef.current) setItems(loaded);
      })
      .catch(() => {
        // A failed load stays silent — invitations must never nag or crash the tab.
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dismiss = useCallback(async (id: number): Promise<void> => {
    if (pendingIdsRef.current.has(id)) return; // per-id guard — no double-fire
    pendingIdsRef.current.add(id);
    const snapshot = itemsRef.current;
    setItems((prev) => withoutId(prev, id)); // optimistic
    try {
      await invitations.dismiss(id);
    } catch (err) {
      if (mountedRef.current) setItems(snapshot); // revert
      throw err;
    } finally {
      pendingIdsRef.current.delete(id);
    }
  }, []);

  return { invitations: items, dismiss };
}
