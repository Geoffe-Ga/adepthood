/**
 * Platform-conditional styling for the journal's reading surface.
 *
 * Kept beside the page's own styles rather than inside them because the value
 * is resolved from the running platform, not from the design tokens.
 */
import { Platform, type ViewStyle } from 'react-native';

type ReadingSurfacePlatform = typeof Platform.OS;

/** A ``ViewStyle`` widened by the web-only CSS properties react-native-web passes through. */
export type WebReadingScrollStyle = ViewStyle & {
  scrollbarGutter?: 'stable';
};

/**
 * On web a scrollbar is drawn inside the scroll container's own box, so it
 * paints over the last characters of every line in the reading column. Holding
 * the gutter open keeps the bar clear of the measure and stops the column
 * reflowing the moment the entry grows long enough to scroll. Native scroll
 * indicators already float outside the content, so they need nothing.
 *
 * Resolved from ``Platform.OS`` rather than ``Platform.select`` to match the
 * repo's convention (the hand-rolled react-native test mocks expose only
 * ``Platform.OS``).
 */
export const buildReadingScrollStyle = (platform: ReadingSurfacePlatform): WebReadingScrollStyle =>
  platform === 'web' ? { scrollbarGutter: 'stable' } : {};

export const readingScrollStyle = buildReadingScrollStyle(Platform.OS);

/** A ``ViewStyle`` whose ``position`` admits the CSS ``sticky`` value react-native-web passes through. */
export type WebPinnedFooterStyle = Omit<ViewStyle, 'position'> & {
  position?: ViewStyle['position'] | 'sticky';
};

/**
 * Keep a footer (the quote-selection surface's Promote / Cancel row) in view
 * while the reader scrolls a long body above it. On web ``position: sticky``
 * with ``bottom: 0`` holds the row at the foot of the scroll viewport until its
 * own place in the flow scrolls into view, so it never covers the last lines
 * and needs no clearance padding. Native ``ScrollView`` has no sticky-bottom
 * primitive, so there the row stays where the flow puts it.
 */
export const buildPinnedFooterStyle = (platform: ReadingSurfacePlatform): WebPinnedFooterStyle =>
  platform === 'web' ? { position: 'sticky', bottom: 0 } : {};

export const pinnedFooterStyle: ViewStyle = buildPinnedFooterStyle(Platform.OS) as ViewStyle;
