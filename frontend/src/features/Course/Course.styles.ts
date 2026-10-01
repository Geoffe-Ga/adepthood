import { StyleSheet } from 'react-native';

import {
  accent,
  BORDER_RADIUS,
  colors,
  editorialType,
  ink,
  INTERACTIVE_TEXT_MIN,
  onShowcase,
  paperShadow,
  radius,
  rhythm,
  SPACING,
  shadows,
  showcase,
  surface,
  surfaceShadow,
  touchTarget,
  uiType,
} from '../../design/tokens';

const STAGE_PILL_SIZE = 40;
const PROGRESS_BAR_HEIGHT = 6;
const STAGE_COVER_ARC = 4;
const CHAPTER_NAV_DISABLED_OPACITY = 0.5;
// The edge of a glass pill: present enough to describe the shape, faint enough
// not to draw a box around it.
const GLASS_HAIRLINE_WIDTH = 1;

// The chapter title shares the reader header row with the Back link, so it
// takes that button face's size and the row reads as one line of chrome.
const READER_HEADER_ROW_SIZE = uiType.button.fontSize;
// A pill's numeral and its completed check are the pill's tappable label.
const STAGE_PILL_LABEL_SIZE = INTERACTIVE_TEXT_MIN;
// A chapter card's type glyph and its status marker are drawn with text glyphs;
// the type glyph sits at the reading size, the status marker at the interactive floor.
const CARD_TYPE_GLYPH_SIZE = editorialType.body.fontSize;
const CARD_STATUS_GLYPH_SIZE = INTERACTIVE_TEXT_MIN;
// Both error titles (landing and reader) share one role and one size.
const STATE_TITLE_SIZE = editorialType.body.fontSize;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: surface.canvas,
  },

  // Editorial header band (#825): aligns ScreenHeader to the screen gutter.
  headerBand: {
    paddingHorizontal: rhythm.screenPaddingH,
  },

  // Stage selector — warm, borderless (the current chapter reads via the ring).
  stageSelectorContainer: {
    paddingVertical: SPACING.sm,
    backgroundColor: surface.canvas,
  },
  stageSelectorContent: {
    paddingHorizontal: rhythm.screenPaddingH,
    gap: SPACING.sm,
  },
  stagePill: {
    width: STAGE_PILL_SIZE,
    height: STAGE_PILL_SIZE,
    borderRadius: STAGE_PILL_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  // The selected stage reads as the "current chapter": accent ring + lift.
  stagePillActive: {
    borderColor: accent.primary,
    ...shadows.medium,
  },
  stagePillText: {
    fontSize: STAGE_PILL_LABEL_SIZE,
    fontWeight: '700',
  },
  stagePillCheck: {
    fontSize: STAGE_PILL_LABEL_SIZE,
  },

  // Stage cover — the showcase "book cover" for the selected stage.
  stageCover: {
    marginHorizontal: rhythm.screenPaddingH,
    marginTop: SPACING.sm,
  },
  // Sentence case: the landing spends its one small-caps role on "Chapters".
  stageCoverEyebrow: {
    ...editorialType.caption,
    color: onShowcase.muted,
    marginBottom: SPACING.xs,
  },
  stageCoverTitle: {
    ...editorialType.title,
    color: onShowcase.primary,
  },
  stageCoverSubtitle: {
    ...editorialType.note,
    color: onShowcase.soft,
    marginTop: 2,
  },
  // Spiral-Dynamics accent rule under the title.
  stageCoverRule: {
    height: STAGE_COVER_ARC,
    width: 56,
    borderRadius: STAGE_COVER_ARC / 2,
    marginTop: SPACING.sm,
  },
  stageCoverProgressTrack: {
    height: STAGE_COVER_ARC,
    borderRadius: STAGE_COVER_ARC / 2,
    backgroundColor: showcase.raised,
    overflow: 'hidden',
    marginTop: SPACING.md,
  },
  stageCoverProgressFill: {
    height: STAGE_COVER_ARC,
    borderRadius: STAGE_COVER_ARC / 2,
  },
  stageCoverProgressLabel: {
    ...editorialType.caption,
    color: onShowcase.muted,
    marginTop: SPACING.xs,
  },

  // "Start here": the titled band gets the screen gutter, so its heading and
  // the intro card beneath it hang from the same edge as the rest of the page.
  introBand: {
    paddingHorizontal: rhythm.screenPaddingH,
  },

  // The "Chapters" band: the landing's one small-caps list spine.
  sectionBand: {
    paddingHorizontal: rhythm.screenPaddingH,
    marginTop: SPACING.md,
  },
  sectionBandLabel: {
    ...editorialType.caption,
    color: ink.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },

  // Stage metadata: each value stacks under its label, so both share the gutter.
  stageMetadata: {
    paddingHorizontal: rhythm.screenPaddingH,
    paddingVertical: SPACING.md,
  },
  stageDetailRow: {
    marginBottom: SPACING.xs,
  },
  stageDetailLabel: {
    ...editorialType.caption,
    color: ink.muted,
  },
  stageDetailValue: {
    ...editorialType.caption,
    color: ink.soft,
  },

  // Stage introduction card — lifted onto a warm raised surface.
  introCard: {
    minHeight: touchTarget.minimum,
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderRadius: radius.md,
    backgroundColor: surface.raised,
    ...surfaceShadow.card,
  },
  introCardLabel: {
    ...editorialType.caption,
    color: ink.muted,
    marginBottom: 2,
  },
  introCardTitle: {
    fontSize: INTERACTIVE_TEXT_MIN,
    fontWeight: '700',
    color: ink.primary,
  },
  introCardSummary: {
    ...editorialType.note,
    color: ink.soft,
    marginTop: SPACING.xs,
  },

  // Progress bar
  progressBarContainer: {
    paddingHorizontal: rhythm.screenPaddingH,
    paddingVertical: SPACING.sm,
  },
  progressBarTrack: {
    height: PROGRESS_BAR_HEIGHT,
    borderRadius: PROGRESS_BAR_HEIGHT / 2,
    backgroundColor: surface.sunken,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: PROGRESS_BAR_HEIGHT,
    borderRadius: PROGRESS_BAR_HEIGHT / 2,
  },
  // Left-aligned: on the gutter with every other landing label.
  progressBarLabel: {
    ...editorialType.caption,
    color: ink.muted,
    marginTop: SPACING.xs,
  },

  // Content card — lifted onto a raised surface, separated by warm spacing.
  contentCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    marginHorizontal: rhythm.screenPaddingH,
    marginBottom: SPACING.sm,
    borderRadius: radius.md,
    backgroundColor: surface.raised,
    ...surfaceShadow.card,
  },
  contentCardLocked: {
    opacity: 0.5,
  },
  contentCardRead: {
    opacity: 0.7,
  },
  contentCardIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.md,
  },
  contentCardIconText: {
    fontSize: CARD_TYPE_GLYPH_SIZE,
  },
  contentCardBody: {
    flex: 1,
  },
  contentCardTitle: {
    fontSize: INTERACTIVE_TEXT_MIN,
    fontWeight: '600',
    color: ink.primary,
    marginBottom: 2,
  },
  contentCardSubtitle: {
    ...editorialType.caption,
    color: ink.soft,
  },
  contentCardStatus: {
    marginLeft: SPACING.sm,
  },
  contentCardStatusText: {
    fontSize: CARD_STATUS_GLYPH_SIZE,
    color: ink.muted,
  },

  // Content viewer — the reader floats a paper sheet on the deeper desk ground.
  viewerContainer: {
    flex: 1,
    backgroundColor: surface.canvas,
  },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: surface.canvas,
  },
  viewerBackButton: {
    paddingRight: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  viewerBackText: {
    ...uiType.button,
    color: accent.primary,
  },
  viewerTitle: {
    flex: 1,
    fontSize: READER_HEADER_ROW_SIZE,
    fontWeight: '600',
    color: ink.primary,
  },
  // The reader's chapter controls float over the prose rather than sitting in
  // the layout: an absolute overlay pinned to the reader's bottom edge, so
  // revealing them moves neither the bottom fade nor a single line of text.
  // ``box-none`` on the wrapper keeps the gaps between pills tappable prose.
  readerFooterOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Reader footer — a column so the transient read toast can float above the
  // single [prev icon] [center action] [next icon] navigation row. No ground of
  // its own: the row is a spacer for the glass pills, not a slab behind them.
  viewerFooter: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  viewerFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  // Glass: a translucent wash, a hairline edge, and a soft shadow — the Map
  // magnifier's vocabulary, borrowed so the reader's chrome floats over prose
  // instead of covering it.
  footerIconButton: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BORDER_RADIUS.circle,
    borderWidth: GLASS_HAIRLINE_WIDTH,
    borderColor: surface.hairline,
    backgroundColor: colors.mystical.glowLight,
    ...surfaceShadow.card,
  },
  // The one control that stays solid: a call to action has to be legible over
  // whatever prose happens to be under it, so the accent fill carries it.
  markReadButton: {
    flex: 1,
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.circle,
    backgroundColor: accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...surfaceShadow.card,
  },
  markReadButtonDone: {
    backgroundColor: surface.sunken,
  },
  // Shared label for buttons painted on an accent surface (mark-read, reflect, retry).
  buttonLabelOnAccent: {
    ...uiType.button,
    color: surface.canvas,
  },
  markReadTextDone: {
    color: ink.soft,
  },
  reflectButton: {
    flex: 1,
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.circle,
    backgroundColor: accent.strong,
    alignItems: 'center',
    justifyContent: 'center',
    ...surfaceShadow.card,
  },
  chapterNavBackDisabled: {
    opacity: CHAPTER_NAV_DISABLED_OPACITY,
  },
  // Transient mark-read confirmation card floated above the footer nav row.
  readToast: {
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    marginBottom: SPACING.sm,
    borderRadius: radius.md,
    backgroundColor: surface.raised,
    ...surfaceShadow.card,
  },
  readToastText: {
    ...editorialType.note,
    fontWeight: '600',
    color: ink.primary,
  },

  // Loading and empty/error states
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  // The slot for the error / timeout state's drawn icon (CourseScreen).
  emptyIcon: {
    marginBottom: SPACING.md,
  },
  emptyTitle: {
    fontSize: STATE_TITLE_SIZE,
    fontWeight: '600',
    color: ink.primary,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  emptySubtitle: {
    ...editorialType.note,
    color: ink.soft,
    textAlign: 'center',
  },

  // Content list
  contentList: {
    flex: 1,
  },
  contentListContent: {
    flexGrow: 1,
    paddingTop: SPACING.sm,
    paddingBottom: rhythm.bottomFadeHeight,
  },

  // Native Markdown reader body — floated on a warm paper sheet.
  // Relative region the bottom fade pins to (its absolute bottom:0 anchors here).
  readerScrollRegion: {
    flex: 1,
  },
  readerScroll: {
    flex: 1,
    backgroundColor: surface.desk,
  },
  readerSheet: {
    marginHorizontal: SPACING.md,
    marginTop: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.lg,
    borderRadius: radius.lg,
    backgroundColor: surface.canvas,
    ...paperShadow.sheet,
  },
  // Small-caps eyebrow over the sheet title (mirrors sectionBandLabel).
  readerEyebrow: {
    ...editorialType.caption,
    color: ink.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: SPACING.xs,
  },
  // Serif editorial title heading the sheet; inherits its size from the token.
  readerTitle: {
    ...editorialType.title,
    color: ink.primary,
    marginBottom: SPACING.sm,
  },
  // Calm, declinable "write a note" invitation shown near the sheet header.
  readerWriteNoteLink: {
    ...editorialType.action,
    color: accent.primary,
    marginBottom: SPACING.sm,
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.xs,
  },
  readerError: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  readerErrorTitle: {
    fontSize: STATE_TITLE_SIZE,
    fontWeight: '600',
    color: ink.primary,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  readerErrorSubtitle: {
    ...editorialType.note,
    color: ink.soft,
    marginBottom: SPACING.md,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: SPACING.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: radius.md,
    backgroundColor: accent.primary,
    alignItems: 'center',
  },

  // Site resources panel
  resourcesPanel: {
    paddingHorizontal: rhythm.screenPaddingH,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
    backgroundColor: surface.canvas,
  },
  resourcesHeading: {
    ...editorialType.caption,
    color: ink.muted,
    marginBottom: SPACING.sm,
  },
  resourcesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  resourceChip: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: radius.md,
    backgroundColor: surface.sunken,
  },
  // A chip is tapped, so its label sits at the interactive floor.
  resourceChipText: {
    ...uiType.button,
    color: ink.primary,
  },
});

export default styles;

/**
 * Styles consumed by ``react-native-markdown-display`` — keys follow the
 * library's rule names, values are plain RN styles built from design
 * tokens (no hardcoded colors/sizes); ``contentImage`` is ours.
 *
 * Chapter text is long-form reading, so it takes the all-serif static
 * ``editorialType`` faces (DESIGN.md "Type system"), not the ``type(width)``
 * chrome ramp: that ramp's body is sans and shrinks to 15 on a narrow phone,
 * and this map is a static sheet handed to ``<Markdown>`` with no width.
 */
export const markdownStyles = StyleSheet.create({
  body: {
    ...editorialType.body,
    color: ink.primary,
  },
  heading1: {
    ...editorialType.title,
    color: ink.primary,
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  heading2: {
    ...editorialType.heading,
    color: ink.primary,
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  heading3: {
    ...editorialType.body,
    fontWeight: '600',
    color: ink.primary,
    marginTop: SPACING.sm,
    marginBottom: SPACING.xs,
  },
  paragraph: {
    marginTop: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  blockquote: {
    backgroundColor: surface.sunken,
    borderLeftWidth: 3,
    borderLeftColor: accent.primary,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    marginVertical: SPACING.sm,
    fontStyle: 'italic',
  },
  code_inline: {
    backgroundColor: surface.sunken,
    borderRadius: radius.sm,
    paddingHorizontal: SPACING.xs,
  },
  code_block: {
    backgroundColor: surface.sunken,
    borderRadius: radius.md,
    padding: SPACING.md,
  },
  fence: {
    backgroundColor: surface.sunken,
    borderRadius: radius.md,
    padding: SPACING.md,
  },
  link: {
    color: accent.primary,
    textDecorationLine: 'underline',
  },
  bullet_list: {
    marginVertical: SPACING.xs,
  },
  ordered_list: {
    marginVertical: SPACING.xs,
  },
  hr: {
    backgroundColor: accent.primary,
    marginVertical: SPACING.md,
  },
  contentImage: {
    width: '100%',
    height: 220,
    marginVertical: SPACING.sm,
    borderRadius: radius.md,
  },
});
