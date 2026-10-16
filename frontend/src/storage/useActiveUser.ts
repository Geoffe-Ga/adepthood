import { useMemo, useSyncExternalStore } from 'react';

import {
  getActiveUser,
  getActiveUserGeneration,
  isAccountScopeCurrent,
  isActiveUserTransitioning,
  subscribeActiveUser,
} from './userScope';

/** Account changes invalidate mounted consumers as well as durable keys. */
export function useActiveUser(): number | null {
  useActiveUserGeneration();
  return getActiveUser();
}

export function useActiveUserGeneration(): number {
  return useSyncExternalStore(
    subscribeActiveUser,
    getActiveUserGeneration,
    getActiveUserGeneration,
  );
}

/**
 * Whether account cleanup is running, so a render can stay unresolved rather
 * than start a lifecycle for the departing namespace (#3368).
 */
export function useActiveUserTransitioning(): boolean {
  return useSyncExternalStore(
    subscribeActiveUser,
    isActiveUserTransitioning,
    isActiveUserTransitioning,
  );
}

/** The account a render belongs to, and the one check async work makes before landing. */
export interface AccountScope {
  owner: number | null;
  epoch: number;
  /** Whether the active account is still the one this render captured. */
  isCurrent: () => boolean;
}

/**
 * Capture the active account for async work started from this render.
 *
 * One object per owner and epoch, so it is a stable effect and callback
 * dependency until the account changes. It answers only "is this still the
 * account?": mounted-lifetime flags, same-account write ordering and what to
 * render while a read is out stay with each caller.
 */
export function useAccountScope(): AccountScope {
  const owner = useActiveUser();
  const epoch = useActiveUserGeneration();
  return useMemo(
    () => ({ owner, epoch, isCurrent: () => isAccountScopeCurrent(owner, epoch) }),
    [owner, epoch],
  );
}
