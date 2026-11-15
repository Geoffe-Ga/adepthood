/**
 * Focus a field without moving the page under the reader (#3718).
 *
 * On web, a plain ``focus()``, which is what React does for ``autoFocus``,
 * scrolls the nearest scroller to show the field's caret. A selection field
 * that opens over a long body puts its caret at offset 0, so the reader is
 * thrown back to the top of the text they were reading.
 * ``preventScroll`` keeps the scroll where it was. Native focus does not scroll
 * a field whose soft keyboard is suppressed, so it focuses plainly there.
 */
import type { Platform } from 'react-native';

/** The one method this needs from a host field (RN TextInput or a DOM textarea). */
export interface FocusableField {
  focus: (_options?: { preventScroll?: boolean }) => void;
}

export function focusWithoutScrolling(
  field: FocusableField | null,
  platform: typeof Platform.OS,
): void {
  if (field == null) return;
  if (platform === 'web') field.focus({ preventScroll: true });
  else field.focus();
}
