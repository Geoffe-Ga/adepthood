import { Platform } from 'react-native';

/**
 * `aria-describedby` for react-native-web, which forwards it to the DOM.
 *
 * React Native's own prop types have no describedby, and on native it would be
 * inert -- native screen readers take the description from `accessibilityHint`,
 * which react-native-web drops. So it is attached on the web only, and typed
 * through a narrowing cast the same way `writingFieldFocus` attaches its
 * web-only CSS. Pass several ids space-separated, as the attribute takes them.
 */
export function webDescribedBy<P>(ids: string | undefined): Partial<P> {
  if (Platform.OS !== 'web' || ids === undefined || ids === '') return {};
  return { 'aria-describedby': ids } as unknown as Partial<P>;
}

/**
 * The radio state react-native-web cannot read from `accessibilityState`,
 * which it does not translate into aria-* attributes. Web only: on native the
 * state already travels in `accessibilityState`, where `selected` (not
 * `checked`) is this codebase's radio convention.
 */
export function webRadioState<P>(checked: boolean, disabled: boolean): Partial<P> {
  if (Platform.OS !== 'web') return {};
  return { 'aria-checked': checked, 'aria-disabled': disabled } as unknown as Partial<P>;
}

/**
 * A toggle button's on/off state for react-native-web, which drops
 * `accessibilityState`. `aria-pressed` is the ARIA for a toggle button
 * (`aria-selected` is not valid on role=button). Web only, as above.
 */
export function webPressedState<P>(pressed: boolean): Partial<P> {
  if (Platform.OS !== 'web') return {};
  return { 'aria-pressed': pressed } as unknown as Partial<P>;
}
