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
