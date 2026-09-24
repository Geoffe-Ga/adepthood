/**
 * Moving focus for the composer: onto its heading when it opens, and back to
 * the control that opened it when it closes (#2898 AC20).
 *
 * The return target is a single slot filled by the control at the moment it is
 * pressed and emptied when used. A listener on the tab navigator's `focus`
 * event would fire on every return to the tabs -- back from Settings too -- and
 * would pull focus onto the feedback button when nobody had pressed it.
 */
import type React from 'react';
import { AccessibilityInfo, Platform, type View } from 'react-native';

type FocusTarget = React.RefObject<View | null>;

let origin: FocusTarget | null = null;

/** Move screen-reader (native) or keyboard (web) focus onto `host`. */
export function focusHost(host: View | null | undefined): void {
  if (!host) return;
  if (Platform.OS === 'web') {
    // react-native-web host components are DOM nodes and expose `focus()`.
    (host as unknown as { focus?: () => void }).focus?.();
    return;
  }
  AccessibilityInfo.sendAccessibilityEvent(host, 'focus');
}

/** Remember which control opened the composer; `null` clears the slot. */
export function rememberFeedbackOrigin(target: FocusTarget | null): void {
  origin = target;
}

/**
 * Return focus to the remembered control, once. A control that has since
 * unmounted (its ref is empty) is skipped rather than chased.
 */
export function restoreFeedbackOrigin(): void {
  const target = origin;
  origin = null;
  focusHost(target?.current);
}
