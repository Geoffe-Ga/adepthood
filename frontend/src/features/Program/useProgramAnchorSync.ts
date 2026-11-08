import { useEffect } from 'react';

import { useAuth } from '../../context/AuthContext';

import { reconcileProgramAnchor } from './programAnchor';

/**
 * Adopt the server's program anchor once per signed-in session (#3097).
 *
 * Keyed on the auth transition and the account zone, not on foregrounds or
 * habit refreshes: the read records a visit (#2666 moved the Journal off such
 * reads), so it runs when a session starts, not whenever a screen loads.
 */
export function useProgramAnchorSync(): void {
  const { authStatus, userTimezone, userTimezoneReady } = useAuth();
  useEffect(() => {
    if (authStatus !== 'authenticated' || !userTimezoneReady) return;
    void reconcileProgramAnchor(userTimezone);
  }, [authStatus, userTimezone, userTimezoneReady]);
}
