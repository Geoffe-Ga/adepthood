import { StyleSheet } from 'react-native';

import {
  accent,
  editorialType,
  ink,
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
} from '../../design/tokens';

const STAGE_PILL_SIZE = 40;
const PROGRESS_BAR_HEIGHT = 6;
const STAGE_COVER_ARC = 4;
const CHAPTER_NAV_DISABLED_OPACITY = 0.5;

// Shared uppercase small-caps label face (muted); consumers add per-use margins.
const upperLabel = {
  fontSize: 12,
  fontWeight: '600',
  color: ink.muted,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
} as const;

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
    paddingHorizontal: SPACING.md,
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
    fontSize: 14,
    fontWeight: '700',
  },
  stagePillCheck: {
    fontSize: 16,
  },

  // Stage cover — the showcase "book cover" for the selected stage.
  stageCover: {
    marginHorizontal: rhythm.screenPaddingH,
    marginTop: SPACING.sm,
  },
  stageCoverEyebrow: {
    ...editorialType.caption,
    color: onShowcase.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
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

  // Editorial section band labels ("Start here" / "Chapters").
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

  // Stage metadata
  stageMetadata: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  stageDetailRow: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginBottom: 4,
  },
  stageDetailLabel: {
    ...upperLabel,
  },
  stageDetailValue: {
    fontSize: 12,
    color: ink.soft,
  },

  // Stage introduction card — lifted onto a warm raised surface.
  introCard: {
    minHeight: touchTarget.minimum,
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderRadius: radius.md,
    backgroundColor: surface.raised,
    ...surfaceShadow.card,
  },
  introCardLabel: {
    ...upperLabel,
    marginBottom: 2,
  },
  introCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: ink.primary,
  },
  introCardSummary: {
    fontSize: 14,
    color: ink.soft,
    marginTop: 4,
  },

  // Progress bar
  progressBarContainer: {
    paddingHorizontal: SPACING.lg,
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
  progressBarLabel: {
    fontSize: 12,
    color: ink.muted,
    marginTop: 4,
    textAlign: 'right',
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
    fontSize: 18,
  },
  contentCardBody: {
    flex: 1,
  },
  contentCardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: ink.primary,
    marginBottom: 2,
  },
  contentCardSubtitle: {
    fontSize: 13,
    color: ink.soft,
  },
  contentCardStatus: {
    marginLeft: SPACING.sm,
  },
  contentCardStatusText: {
    fontSize: 16,
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
    fontSize: 16,
    color: accent.primary,
    fontWeight: '600',
  },
  viewerTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: ink.primary,
  },
  // Reader footer — a column so the transient read toast can float above the
  // single [prev icon] [center action] [next icon] navigation row.
  viewerFooter: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    backgroundColor: surface.canvas,
  },
  viewerFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  footerIconButton: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markReadButton: {
    flex: 1,
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: radius.md,
    backgroundColor: accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markReadButtonDone: {
    backgroundColor: surface.sunken,
  },
  // Shared label for buttons painted on an accent surface (mark-read, reflect, retry).
  buttonLabelOnAccent: {
    fontSize: 15,
    fontWeight: '600',
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
    borderRadius: radius.md,
    backgroundColor: accent.strong,
    alignItems: 'center',
    justifyContent: 'center',
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
  emptyIcon: {
    fontSize: 48,
    marginBottom: SPACING.md,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: ink.primary,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: ink.soft,
    textAlign: 'center',
    lineHeight: 20,
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
    fontSize: 16,
    fontWeight: '600',
    color: ink.primary,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  readerErrorSubtitle: {
    fontSize: 14,
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
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
    backgroundColor: surface.canvas,
  },
  resourcesHeading: {
    ...upperLabel,
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
  resourceChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: ink.primary,
  },
});

export default styles;

/**
 * Styles consumed by ``react-native-markdown-display`` — keys follow the
 * library's rule names, values are plain RN styles built from design
 * tokens (no hardcoded colors/sizes).  Headings use the serif editorial face;
 * ``contentImage`` and the reader chrome above are ours.
 */
export const markdownStyles = StyleSheet.create({
  body: {
    fontSize: 17,
    lineHeight: 26,
    color: ink.primary,
  },
  heading1: {
    ...editorialType.title,
    color: ink.primary,
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  heading2: {
    fontFamily: editorialType.serif,
    fontSize: 21,
    fontWeight: '600',
    color: ink.primary,
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  heading3: {
    fontFamily: editorialType.serif,
    fontSize: 18,
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
