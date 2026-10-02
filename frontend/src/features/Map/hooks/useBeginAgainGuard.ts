/** Ref-guarded single-flight begin-again: blocks same-tick double-press, state drives disabled UI. */

import { useCallback, useRef, useState } from 'react';

import { stageService } from '../services/stageService';

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

  const handleBeginAgain = useCallback(() => {
    // Ref guard blocks a same-tick double-press; state drives the disabled UI.
    if (beginningRef.current) return;
    beginningRef.current = true;
    setBeginning(true);
    void stageService.beginAgain().finally(() => {
      beginningRef.current = false;
      if (!isMountedRef.current) return;
      setBeginning(false);
    });
  }, [isMountedRef]);

  return { beginning, handleBeginAgain };
}
