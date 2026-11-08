/** Ref-guarded single-flight begin-again: blocks same-tick double-press, state drives disabled UI. */

import { useCallback, useRef, useState } from 'react';

import { stageService } from '../services/stageService';

import { useAuth } from '@/context/AuthContext';
import { useMountedRef } from '@/hooks/useMountedRef';

/** Returns { beginning, handleBeginAgain } — one POST /stages/begin-again per in-flight window. */
export function useBeginAgainGuard(): { beginning: boolean; handleBeginAgain: () => void } {
  // In-flight guard: each POST increments cycle_number, so a double-press must
  // send exactly one request until loadStages hides the button.
  const [beginning, setBeginning] = useState(false);
  const beginningRef = useRef(false);

  // The begin-again POST is fire-and-forget: unmounting the Map screen while it
  // is in flight must not land setBeginning on a torn-down component. This guard
  // skips the settle-time state update after unmount, via the shared
  // useMountedRef, without changing the happy-path behaviour.
  const isMountedRef = useMountedRef();

  // The new cycle's start day is counted in the account zone (#3702). While
  // that zone is still the provisional default it is not the person's, so no
  // zone is passed and the day waits for the next reconcile.
  const { userTimezone, userTimezoneReady } = useAuth();
  const zone = userTimezoneReady ? userTimezone : null;

  const handleBeginAgain = useCallback(() => {
    // Ref guard blocks a same-tick double-press; state drives the disabled UI.
    if (beginningRef.current) return;
    beginningRef.current = true;
    setBeginning(true);
    void stageService.beginAgain(undefined, zone).finally(() => {
      beginningRef.current = false;
      if (!isMountedRef.current) return;
      setBeginning(false);
    });
  }, [isMountedRef, zone]);

  return { beginning, handleBeginAgain };
}
