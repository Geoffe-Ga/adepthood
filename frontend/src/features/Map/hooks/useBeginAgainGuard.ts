/** Ref-guarded single-flight begin-again: blocks same-tick double-press, state drives disabled UI. */

import { useCallback, useRef, useState } from 'react';

import { stageService } from '../services/stageService';

/** Returns { beginning, handleBeginAgain } — one POST /stages/begin-again per in-flight window. */
export function useBeginAgainGuard(): { beginning: boolean; handleBeginAgain: () => void } {
  // In-flight guard: each POST increments cycle_number, so a double-press must
  // send exactly one request until loadStages hides the button.
  const [beginning, setBeginning] = useState(false);
  const beginningRef = useRef(false);

  const handleBeginAgain = useCallback(() => {
    // Ref guard blocks a same-tick double-press; state drives the disabled UI.
    if (beginningRef.current) return;
    beginningRef.current = true;
    setBeginning(true);
    void stageService.beginAgain().finally(() => {
      beginningRef.current = false;
      setBeginning(false);
    });
  }, []);

  return { beginning, handleBeginAgain };
}
