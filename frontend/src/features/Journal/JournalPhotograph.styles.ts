/**
 * Styles for the Journal photograph-capture screen — the editorial "paper" idiom
 * shared with the writing surface (warm paper ground, serif body). Tokens only.
 */
import { StyleSheet } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  spacing,
  touchTarget,
} from '@/design/tokens';

/** Minimum height for the editable preview so a short transcription still reads
 *  as a full page rather than a cramped single-line field. */
const PREVIEW_MIN_HEIGHT = spacing(30);

/** Thumbnail footprint for a collected page: a portrait card wide enough to read
 *  the page number badge and remove affordance without crowding the image. */
const THUMBNAIL_WIDTH = spacing(12);
const THUMBNAIL_HEIGHT = spacing(16);

const styles = StyleSheet.create({
  /** Vertical stack for a phase's copy + affordances, with editorial breathing room. */
  container: {
    flex: 1,
    gap: SPACING.md,
  },
  heading: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  message: {
    ...editorialType.body,
    color: colors.paper.inkSoft,
  },
  /** The quiet "reading your page" block shown while transcription is in flight. */
  fillingBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    backgroundColor: colors.paper.background,
  },
  /** The editable transcription preview: a growing, top-aligned paper field. */
  previewInput: {
    flexGrow: 1,
    minHeight: PREVIEW_MIN_HEIGHT,
    ...editorialType.body,
    color: colors.paper.ink,
    backgroundColor: colors.paper.background,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    padding: SPACING.md,
    textAlignVertical: 'top',
  },
  /** A quiet date row above the actions: a low-pressure, declinable backdate. */
  entryDateRow: {
    gap: SPACING.xs,
  },
  /** The soft label sitting above the picker, in the editorial paper idiom. */
  entryDateLabel: {
    ...editorialType.body,
    color: colors.paper.inkSoft,
  },
  /** Stacked action buttons under a phase's copy. */
  actions: {
    gap: SPACING.sm,
  },
  /** The collect stage: the page strip over its add/transcribe affordances. */
  collect: {
    flex: 1,
    gap: SPACING.md,
  },
  /** Horizontal padding around the strip so end cards aren't flush to the edge. */
  stripContent: {
    gap: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  /** One page card: a portrait thumbnail carrying its number badge and remove tap. */
  pageCard: {
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    backgroundColor: colors.paper.backgroundAlt,
    overflow: 'hidden',
  },
  /** Lifted, softened state while a card is being dragged to a new position. */
  pageCardActive: {
    opacity: 0.9,
    borderColor: colors.paper.ink,
  },
  /** The page image itself, filling the card. */
  pageThumbnail: {
    width: '100%',
    height: '100%',
  },
  /** A 1-based order badge pinned to the card's top-left corner. */
  pageBadge: {
    position: 'absolute',
    top: SPACING.xs,
    left: SPACING.xs,
    minWidth: SPACING.xl,
    paddingHorizontal: SPACING.xs,
    borderRadius: BORDER_RADIUS.circle,
    backgroundColor: colors.paper.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The badge's number, in the paper ground colour for contrast on the ink chip. */
  pageBadgeText: {
    ...editorialType.caption,
    color: colors.paper.background,
  },
  /** The remove affordance: a full 44dp tap target in the card's top-right. */
  pageRemove: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The remove glyph, on a soft paper chip so it reads over any thumbnail. */
  pageRemoveGlyph: {
    ...editorialType.body,
    color: colors.paper.ink,
    width: SPACING.xl,
    height: SPACING.xl,
    borderRadius: BORDER_RADIUS.circle,
    textAlign: 'center',
    overflow: 'hidden',
    backgroundColor: colors.paper.background,
  },
  /** Warm, low-pressure notice copy under the strip (cap reached, multi-page gate). */
  notice: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
  },
});

export default styles;
