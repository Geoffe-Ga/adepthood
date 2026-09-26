/**
 * Focus handoff for a control that replaces the one the user just pressed.
 *
 * When a press unmounts the focused control (the care note's X, #2862), the
 * platform drops focus: to ``<body>`` on the web, nowhere in particular on a
 * native screen reader. The user then has to hunt for what took its place.
 * This moves focus onto the new control instead — ``focus()`` on the web, where
 * the host element is a DOM node, and ``setAccessibilityFocus`` on native,
 * which moves VoiceOver/TalkBack and speaks the target's label.
 *
 * ``webTarget`` exists because the best native landing is not always focusable
 * on the web: a heading is a plain element there, so a caller can name a
 * ``tabIndex={-1}`` container to focus instead.
 */
import { AccessibilityInfo, Platform, findNodeHandle } from 'react-native';
import type { Text, View } from 'react-native';

/** A mounted host view or text the focus can land on; ``null`` before mount. */
export type FocusTarget = View | Text | null;

export function moveAccessibilityFocus(target: FocusTarget, webTarget: FocusTarget = target): void {
  if (Platform.OS === 'web') {
    webTarget?.focus();
    return;
  }
  if (target === null) return;
  const handle = findNodeHandle(target);
  if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
}
