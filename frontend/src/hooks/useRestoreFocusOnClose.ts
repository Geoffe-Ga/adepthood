/**
 * Hand focus back to the control that opened a surface once the surface closes.
 *
 * An explicit ref, not a captured ``document.activeElement``: a pointer press
 * does not reliably focus the opener on every engine, and a programmatic open
 * would capture ``body``. Fires only on an open -> closed transition, never on
 * first mount, so a screen that starts closed does not steal focus.
 *
 * Focus is only RETURNED, never taken: when a text field outside the surface
 * still holds it (Escape pressed while typing in the editor), the writer stays
 * in their text (#2883). A field that lived inside the closed surface is gone
 * from the document by then, so it does not count.
 */
import { useEffect, useRef } from 'react';
import type React from 'react';
import { Platform, TextInput } from 'react-native';

/** Tags whose focus means the reader is typing. */
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA']);

/** True when a still-mounted text field holds focus, so moving it would interrupt typing. */
function textFieldHoldsFocus(): boolean {
  if (Platform.OS === 'web') {
    const active = document.activeElement as HTMLElement | null;
    if (active == null || !active.isConnected) return false;
    return TEXT_ENTRY_TAGS.has(active.tagName) || active.isContentEditable === true;
  }
  return TextInput.State.currentlyFocusedInput() != null;
}

export function useRestoreFocusOnClose(
  open: boolean,
  target: React.RefObject<{ focus: () => void } | null>,
): void {
  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (closed && !textFieldHoldsFocus()) target.current?.focus();
  }, [open, target]);
}
