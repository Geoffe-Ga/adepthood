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

/** The dock's layer: above the field and the pinned footer drawn before it, and no higher. */
export const FLOATING_DOCK_LAYER = 1;

/**
 * The frame a floating action (``FloatingPromoteButton``, #3134) positions
 * itself in: the pill sits a fixed lift above the dock's foot, centred across
 * it, so the dock decides where "the bottom of the page" is.
 *
 * On web the dock is a zero-height ``position: sticky`` strip with
 * ``bottom: 0``, the last thing in the surface: like the pinned footer, it
 * rides the foot of the nearest scroll viewport (the journal page, a review's
 * sources pane or sheet) while a long body scrolls past, and it spans the
 * surface's own column, so the pill centres over the text being read rather
 * than over the window. Having no height, it pushes nothing.
 *
 * Native ``ScrollView`` has no sticky-bottom primitive, so there the dock fills
 * the surface and the pill floats at the surface's foot. It must fill rather
 * than collapse: Android delivers no touch to a child drawn outside its
 * parent's bounds. The host gives it ``pointerEvents="box-none"`` so the text
 * beneath stays selectable.
 */
export const buildFloatingDockStyle = (platform: ReadingSurfacePlatform): WebPinnedFooterStyle =>
  platform === 'web'
    ? { position: 'sticky', bottom: 0, height: 0, zIndex: FLOATING_DOCK_LAYER }
    : { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: FLOATING_DOCK_LAYER };

export const floatingDockStyle: ViewStyle = buildFloatingDockStyle(Platform.OS) as ViewStyle;
