import { useEffect, useRef } from 'react';

import { useAuth } from '@/context/AuthContext';
import { useActiveUser, useActiveUserGeneration } from '@/storage/useActiveUser';
import { parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

/**
 * The authenticated lifecycle Course content belongs to, or ``null`` while no
 * credential matches the active scope (#3343).
 *
 * The Course tab stays mounted while the re-auth sheet signs another account
 * in, so its loaders must notice the incoming owner themselves. Auth moves the
 * durable scope before it commits the new token, so the key settles only once
 * both agree. A same-session renewal changes the token but neither the owner
 * nor the generation, so it keeps the key and reloads nothing.
 */
export function useCourseSessionKey(): string | null {
  const { token } = useAuth();
  const owner = useActiveUser();
  const generation = useActiveUserGeneration();
  const credentialOwner = token ? parseUserId(decodeJwtPayload(token)?.sub) : null;
  return owner !== null && credentialOwner === owner ? `${owner}:${generation}` : null;
}

/**
 * Run ``start`` on mount and again for every new authenticated lifecycle,
 * calling ``supersede`` whenever either changes and on unmount.
 *
 * Mid-switch there is no credential for the scope yet; the older lifecycle's
 * work is superseded at once, but nothing new starts until the incoming
 * credential lands, so the gap never surfaces as a failure. Both callbacks
 * must be stable (``useCallback``) or the effect re-runs every render.
 */
export function useEachCourseSession(
  sessionKey: string | null,
  start: () => void,
  supersede: () => void,
): void {
  const started = useRef(false);
  useEffect(() => {
    if (sessionKey === null && started.current) return supersede;
    started.current = true;
    start();
    return supersede;
  }, [sessionKey, start, supersede]);
}
