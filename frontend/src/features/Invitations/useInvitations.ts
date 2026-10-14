/**
 * ``useInvitations`` — loads the pending invitation surface on mount and decays
 * it one tap at a time.
 *
 * Silent by default: an empty list is the common, un-nagging case. ``dismiss``
 * removes the row optimistically, calls ``invitations.dismiss`` (idempotent),
 * and reverts on error. A per-id guard prevents a double-tap from double-firing,
 * and an unmount guard keeps late resolutions from setting state on a dead hook.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import { invitations } from '@/api';
import type { Invitation } from '@/api';
import { useAuth } from '@/context/AuthContext';
import { useMountedRef } from '@/hooks/useMountedRef';
import { getActiveUser } from '@/storage/userScope';

export interface UseInvitationsResult {
  invitations: Invitation[];
  dismiss: (_id: number) => Promise<void>;
}

/** Return the list without the invitation carrying ``id`` (order-preserving). */
function withoutId(list: Invitation[], id: number): Invitation[] {
  return list.filter((invitation) => invitation.id !== id);
}

/** Restore one failed row against the original server order, never a whole snapshot. */
function restoreRow(current: Invitation[], original: Invitation[], id: number): Invitation[] {
  const row = original.find((item) => item.id === id);
  if (!row || current.some((item) => item.id === id)) return current;
  const order = new Map(original.map((item, index) => [item.id, index]));
  return [...current, row].sort(
    (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
  );
}

interface InvitationState {
  itemsRef: MutableRefObject<Invitation[]>;
  originalRef: MutableRefObject<Invitation[]>;
  pendingIdsRef: MutableRefObject<Set<number>>;
  generation: MutableRefObject<number>;
  currentToken: MutableRefObject<string | null>;
  mountedRef: MutableRefObject<boolean>;
}

async function dismissRow(
  id: number,
  state: InvitationState,
  publish: (_next: Invitation[]) => void,
): Promise<void> {
  const { pendingIdsRef, itemsRef, originalRef, generation, currentToken, mountedRef } = state;
  const pending = pendingIdsRef.current;
  if (pending.has(id) || !itemsRef.current.some((item) => item.id === id)) return;
  pending.add(id);
  const requestGeneration = generation.current;
  const owner = getActiveUser() ?? currentToken.current;
  const token = currentToken.current;
  const original = originalRef.current;
  publish(withoutId(itemsRef.current, id));
  try {
    await invitations.dismiss(id, token ?? undefined);
  } catch (err) {
    if (
      mountedRef.current &&
      generation.current === requestGeneration &&
      (getActiveUser() ?? currentToken.current) === owner
    ) {
      publish(restoreRow(itemsRef.current, original, id));
    }
    throw err;
  } finally {
    pending.delete(id);
  }
}

function loadRows(state: InvitationState, publish: (_next: Invitation[]) => void): () => void {
  const { generation, pendingIdsRef, originalRef, mountedRef, currentToken } = state;
  const requestGeneration = ++generation.current;
  const owner = getActiveUser() ?? currentToken.current;
  const token = currentToken.current;
  pendingIdsRef.current = new Set();
  originalRef.current = [];
  publish([]);
  void invitations
    .list(token ?? undefined)
    .then((loaded) => {
      if (
        !mountedRef.current ||
        generation.current !== requestGeneration ||
        (getActiveUser() ?? currentToken.current) !== owner
      )
        return;
      originalRef.current = loaded;
      publish(loaded);
    })
    .catch(() => {
      // A failed load stays silent — invitations must never nag or crash the tab.
    });
  return () => {
    generation.current += 1;
  };
}

export function useInvitations(): UseInvitationsResult {
  const { token } = useAuth();
  const [items, setItems] = useState<Invitation[]>([]);
  const itemsRef = useRef<Invitation[]>([]);
  const originalRef = useRef<Invitation[]>([]);
  const pendingIdsRef = useRef<Set<number>>(new Set());
  const generation = useRef(0);
  const currentToken = useRef(token);
  currentToken.current = token;
  const mountedRef = useMountedRef();
  const state = useRef({
    itemsRef,
    originalRef,
    pendingIdsRef,
    generation,
    currentToken,
    mountedRef,
  });
  const owner = getActiveUser() ?? token;
  const publish = useCallback((next: Invitation[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  // A token refresh keeps this account's pending choices; a different owner starts afresh.
  useEffect(() => loadRows(state.current, publish), [owner, publish]);
  const dismiss = useCallback((id: number) => dismissRow(id, state.current, publish), [publish]);
  return { invitations: items, dismiss };
}
