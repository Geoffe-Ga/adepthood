/**
 * Hand focus back to the control that opened a surface once the surface closes.
 *
 * An explicit ref, not a captured ``document.activeElement``: a pointer press
 * does not reliably focus the opener on every engine, and a programmatic open
 * would capture ``body``. Fires only on an open -> closed transition, never on
 * first mount, so a screen that starts closed does not steal focus.
 */
import { useEffect, useRef } from 'react';
import type React from 'react';

export function useRestoreFocusOnClose(
  open: boolean,
  target: React.RefObject<{ focus: () => void } | null>,
): void {
  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (closed) target.current?.focus();
  }, [open, target]);
}
