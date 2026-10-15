import { useSyncExternalStore } from 'react';

import { getActiveUser, getActiveUserGeneration, subscribeActiveUser } from './userScope';

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
