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

/** Minimum height for one page's block (skeleton or editable field) so each page
 *  keeps a steady footprint as it moves from reading to editable text. */
const BLOCK_MIN_HEIGHT = spacing(20);

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
  message: {
    ...editorialType.body,
    color: colors.paper.inkSoft,
  },
  /** The quiet, centred "we're working" block shown while the picker is opening. */
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
  /** Warm, low-pressure notice copy under the strip (shown when the session is full). */
  notice: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
  },
  /** The running progress line above Save while a multi-page run is still settling. */
  progress: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
  },
  /** The vertical stack of per-page blocks in the review phase. */
  blocks: {
    gap: SPACING.md,
  },
  /** One page's block: a paper card grouping its skeleton / input / error body. */
  block: {
    gap: SPACING.sm,
  },
  /** A done block's editable body: its text field over its redo affordances. */
  blockBody: {
    gap: SPACING.sm,
  },
  /** The quiet "reading this page" placeholder while a block is pending or in flight. */
  blockSkeleton: {
    minHeight: BLOCK_MIN_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    backgroundColor: colors.paper.backgroundAlt,
  },
  /** One page's editable transcription: a growing, top-aligned paper field. */
  blockInput: {
    minHeight: BLOCK_MIN_HEIGHT,
    ...editorialType.body,
    color: colors.paper.ink,
    backgroundColor: colors.paper.background,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    padding: SPACING.md,
    textAlignVertical: 'top',
  },
  /** Row of block-level affordances (redo, retry/retake, remove) under a block. */
  blockActions: {
    gap: SPACING.sm,
  },
  /** A failed page's recovery card: soft destructive ground with a clear border. */
  blockError: {
    gap: SPACING.sm,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.destructive.border,
    backgroundColor: colors.destructive.background,
  },
  /** The failure copy inside a recovery card, in the destructive ink. */
  blockErrorText: {
    ...editorialType.body,
    color: colors.destructive.text,
  },
  /** The privacy classification chooser above the strip: the tier control over
   *  its intimate transcription gate, with editorial breathing room. */
  classification: {
    gap: SPACING.sm,
  },
  /** The intimate gate: a soft paper card carrying the one-promise copy and its
   *  two declinable actions (type instead / keep as personal). */
  intimateGate: {
    gap: SPACING.sm,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    backgroundColor: colors.paper.backgroundAlt,
  },
  /** The gate's warm, non-shaming explanation copy, in the soft editorial ink. */
  intimateGateText: {
    ...editorialType.body,
    color: colors.paper.inkSoft,
  },
});

export default styles;
