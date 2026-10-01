import { Platform, type AccessibilityProps } from 'react-native';

/** Android's value that drops an element and its whole subtree from TalkBack. */
export const HIDE_SUBTREE = 'no-hide-descendants' as const;
/** Android's default: the element decides for itself whether TalkBack reads it. */
export const EXPOSE_SUBTREE = 'auto' as const;

/** The accessibility props `decorativeHidden` may set, typed by React Native itself. */
export type DecorativeHiddenProps = Pick<
  AccessibilityProps,
  'aria-hidden' | 'accessible' | 'accessibilityElementsHidden' | 'importantForAccessibility'
>;

/**
 * The one spelling for "assistive technology should skip this" (#3009, #2829).
 *
 * Spread it on a decorative glyph, on the wrapper around one, or -- through the
 * conditional form, `decorativeHidden(isHidden)` -- on UI that is on its way out
 * of view. A spread site never hand-writes these props; a source guard
 * (`__tests__/wiring/decorativeHiddenGuard.test.ts`) holds the tree to that.
 *
 * It answers per platform because the platforms read different props:
 *
 * - **Web.** react-native-web 0.21 turns only `aria-hidden` into the DOM
 *   attribute and drops `accessibilityElementsHidden` and
 *   `importantForAccessibility`, so a glyph hidden with those alone was still
 *   read aloud (#3009). On a lucide-react-native or react-native-svg element
 *   the web build forwards every unknown prop to the `<svg>` and its paths, so
 *   `accessible={false}` there became an invalid DOM attribute and a React
 *   console error (#2829). The web answer is therefore `aria-hidden` and
 *   nothing else, which is valid on a View and on an svg alike.
 * - **Native.** React Native 0.86 maps `aria-hidden` itself, and the explicit
 *   iOS (`accessibilityElementsHidden`) and Android (`importantForAccessibility`)
 *   props are kept so no native reader loses what it read before; hidden also
 *   sets `accessible: false` so a leaf Text is not its own VoiceOver element.
 *   Shown sets no `accessible` key, so a revealed band keeps its grouping.
 *
 * Hiding is not disabling: a focusable control inside a hidden subtree is
 * still reachable by keyboard on the web, so a caller hiding live controls
 * must also take them out of the tab order while hidden.
 */
export function decorativeHidden(hidden = true): DecorativeHiddenProps {
  if (Platform.OS === 'web') return { 'aria-hidden': hidden };
  const native: DecorativeHiddenProps = {
    'aria-hidden': hidden,
    accessibilityElementsHidden: hidden,
    importantForAccessibility: hidden ? HIDE_SUBTREE : EXPOSE_SUBTREE,
  };
  return hidden ? { ...native, accessible: false } : native;
}
