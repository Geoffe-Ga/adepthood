// frontend/features/Map/Map.styles.ts

import { StyleSheet } from 'react-native';

import {
  accent,
  colors,
  editorialType,
  ink,
  onShowcase,
  radius,
  shadows,
  showcase,
  showcaseShadow,
  spacing,
  surface,
  touchTarget,
} from '../../design/tokens';

import { GRID_COLUMN_FLEX } from './mapLayout';

// --- Grid weights for the three cells of every stage row -------------------
// One responsive row grid is the single source of vertical truth: each stage
// row is [LeftCell | CenterCell | RightCell] with these flex weights (≈40/40/20),
// so the three columns are siblings in the same row and cannot drift. The
// weights live in mapLayout so the wave geometry can share the same truth.
const LEFT_FLEX = GRID_COLUMN_FLEX.left;
const CENTER_FLEX = GRID_COLUMN_FLEX.center;
const RIGHT_FLEX = GRID_COLUMN_FLEX.right;
const CENTER = 'center';

// Line height for the right-column aspect label, tuned to its fontSize 15 so
// the up-to-two hyphenated lines stay compact and centered without pushing
// neighboring rows.
const RIGHT_LABEL_LINE_HEIGHT = 19;

// --- Soft grid rules -------------------------------------------------------
// The Map is a table, and a table reads as one through its rules: gentle
// horizontal lines between the aspect bands (and the stacked stages within
// them) and vertical lines between the three columns. Drawn as the thinnest
// hairline the platform can render, in the faint warm rule colour, so they
// whisper the grid over the parchment rather than caging it.
const GRID_LINE_COLOR = surface.hairline;
const GRID_LINE_WIDTH = StyleSheet.hairlineWidth;

/**
 * Styles for the Map's spiral-of-becoming grid + the rich stage-detail modal.
 * The grid is token-only and laid out purely with flex; the modal keeps the
 * existing mystical treatment.
 */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: surface.canvas,
  },

  // Loading / error states
  centered: {
    flex: 1,
    alignItems: CENTER,
    justifyContent: CENTER,
    backgroundColor: surface.canvas,
  },
  loadingText: {
    color: ink.primary,
    fontSize: 14,
    marginTop: spacing(1),
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    textAlign: CENTER,
    paddingHorizontal: spacing(2),
  },

  // --- The single responsive row grid --------------------------------------
  grid: {
    flex: 1,
  },
  // One stage row; flex weight set inline to stageNumbers.length so a paired
  // row is twice the height of a single-stage row.
  groupRow: {
    flexDirection: 'row',
  },
  leftCell: {
    flex: LEFT_FLEX,
    borderRightWidth: GRID_LINE_WIDTH,
    borderRightColor: GRID_LINE_COLOR,
  },
  centerCell: {
    flex: CENTER_FLEX,
    borderRightWidth: GRID_LINE_WIDTH,
    borderRightColor: GRID_LINE_COLOR,
  },
  rightCell: {
    flex: RIGHT_FLEX,
    justifyContent: CENTER,
    paddingHorizontal: spacing(1),
  },
  // Shared soft horizontal rule: a row boundary (applied to the group row) or a
  // within-row stage boundary (applied to a stacked stage's cell). Both share
  // the same faint hairline so the table's lines read as one gentle system.
  horizontalDivider: {
    borderTopWidth: GRID_LINE_WIDTH,
    borderTopColor: GRID_LINE_COLOR,
  },

  // Left-column stage text block (also the tap target -0). A row so a locked
  // stage's padlock sits on the far left while the three text lines keep the
  // box's full height, vertically centered — never a fourth stacked line.
  stageBlock: {
    flex: 1,
    flexDirection: 'row',
    alignItems: CENTER,
    paddingHorizontal: spacing(1),
    paddingVertical: spacing(0.5),
  },
  // The persona / descriptor / practice column fills the remaining width and
  // centers its three lines across the block's height.
  stageLines: {
    flex: 1,
    justifyContent: CENTER,
  },
  personaText: {
    fontWeight: '700',
    fontSize: 14,
    textAlign: 'right',
  },
  lineText: {
    fontSize: 12,
    textAlign: 'right',
  },

  // Right-column aspect label: fixed serif size rendered on up to two
  // pre-hyphenated lines, its line height kept compact so a two-line label
  // stays vertically centered without pushing neighboring rows.
  rightLabelText: {
    fontFamily: editorialType.serif,
    fontSize: 15,
    lineHeight: RIGHT_LABEL_LINE_HEIGHT,
    color: ink.primary,
  },

  // --- Center column: per-stage arrow cell (tap target -1) ------------------
  centerStageCell: {
    flex: 1,
    minHeight: touchTarget.minimum,
    alignItems: CENTER,
    justifyContent: CENTER,
    paddingHorizontal: spacing(0.5),
  },
  // Polarity is now carried by the sine-wave overlay, so the center cells stay
  // transparent and let the wave read through the whole column.
  cellFeminine: {
    backgroundColor: 'transparent',
  },
  cellMasculine: {
    backgroundColor: 'transparent',
  },
  // Brighter "you are here" current-stage marker: a thicker accent halo +
  // recessed warm fill so the live stage reads at a glance.
  cellCurrent: {
    borderWidth: 3,
    borderColor: accent.strong,
    borderRadius: radius.md,
    backgroundColor: surface.desk,
    ...shadows.medium,
  },
  // "You are here" pill stacked in flow above the current stage's label.
  youAreHere: {
    marginBottom: spacing(0.25),
    paddingVertical: spacing(0.25),
    paddingHorizontal: spacing(0.5),
    borderRadius: radius.sm,
    backgroundColor: accent.strong,
  },
  youAreHereText: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.text.light,
    letterSpacing: 0.5,
  },
  // Aspect-label block hugging a center-cell corner (opposite the wave's
  // return pole). ``alignSelf`` escapes the cell's centering so the word +
  // its unlock estimate group against the edge, in flow (no absolute overlay).
  labelBlockLeft: {
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
  },
  labelBlockRight: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  arrowLabelText: {
    fontWeight: '700',
    fontSize: 12,
    color: ink.soft,
    flexShrink: 1,
  },
  // Measured wrapper for the EMPTINESS / UNITY watermark: stretches to the
  // cell's inner width so the fitted font size is computed from real pixels.
  titleFit: {
    alignSelf: 'stretch',
    alignItems: CENTER,
  },
  // Responsive title carried in the top stage rows' own grid cells (no fixed
  // 40px overlay): the serif ramp scales rather than overflowing the column.
  titleText: {
    ...editorialType.title,
    color: ink.muted,
    letterSpacing: 1,
    textAlign: CENTER,
  },
  // Thin connector between a stage and the one below it (replaces the old
  // percentage-positioned connection line).
  connector: {
    width: 2,
    height: spacing(1),
    marginTop: spacing(0.25),
    backgroundColor: surface.hairline,
  },

  // Lock glyph row, stacked in flow beneath a locked stage's label
  lockRow: {
    alignItems: CENTER,
    marginTop: spacing(0.25),
  },
  lockText: {
    fontSize: 14,
    color: ink.muted,
  },
  // Left-column padlock: pinned to the far left of the stage block's row,
  // vertically centered by the row's alignItems.
  lockLeft: {
    fontSize: 14,
    color: ink.muted,
    marginRight: spacing(0.5),
  },
  // Locked stages read recessed
  locked: {
    opacity: 0.4,
  },
  // Unlock estimate ("Unlocks in N days") grouped under the Aspect word inside
  // the corner-hugging label block. Its text aligns to the same corner as the
  // block via the left/right variants below, so the copy reads away from the
  // wave strand rather than spanning and centering across the cell.
  unlockTimeline: {
    marginTop: spacing(0.25),
    fontSize: 9,
    color: ink.muted,
    paddingHorizontal: spacing(0.25),
  },
  unlockTimelineLeft: {
    textAlign: 'left',
  },
  unlockTimelineRight: {
    textAlign: 'right',
  },

  // --- Stage-completion celebration banner ----------------------------------
  celebrationBanner: {
    position: 'absolute',
    top: spacing(2),
    alignSelf: CENTER,
    maxWidth: '90%',
    backgroundColor: showcase.canvas,
    borderRadius: radius.md,
    paddingVertical: spacing(1.25),
    paddingHorizontal: spacing(2.5),
    borderLeftWidth: 4,
    borderLeftColor: accent.primary,
    ...showcaseShadow,
  },
  celebrationText: {
    fontFamily: editorialType.serif,
    fontSize: 15,
    fontWeight: '700',
    color: onShowcase.primary,
    textAlign: CENTER,
  },

  // --- Journey read header --------------------------------------------------
  journeyHeader: {
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(2),
    alignItems: CENTER,
    backgroundColor: surface.sunken,
    borderBottomWidth: 1,
    borderBottomColor: surface.hairline,
  },
  journeyReadText: {
    fontFamily: editorialType.serif,
    fontSize: 16,
    fontWeight: '700',
    color: ink.primary,
    letterSpacing: 0.5,
  },
  // Subtle "Cycle N" caption in the journey header (a wheel, not a rank).
  cycleIndicator: {
    fontFamily: editorialType.serif,
    fontSize: 12,
    color: ink.muted,
    marginTop: spacing(0.25),
    letterSpacing: 0.5,
  },

  // --- Begin-again affordance (end-of-arc, declinable) ----------------------
  beginAgain: {
    marginTop: spacing(1.5),
    alignItems: CENTER,
    gap: spacing(0.5),
  },
  beginAgainHeading: {
    fontFamily: editorialType.serif,
    fontSize: 16,
    fontWeight: '700',
    color: onShowcase.primary,
    textAlign: CENTER,
  },
  beginAgainBody: {
    fontFamily: editorialType.serif,
    fontSize: 13,
    lineHeight: 20,
    color: onShowcase.soft,
    textAlign: CENTER,
  },

  // Completed stage checkmark
  completedBadge: {
    position: 'absolute',
    top: spacing(0.25),
    right: spacing(0.25),
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.success,
    alignItems: CENTER,
    justifyContent: CENTER,
  },
  completedBadgeText: {
    fontSize: 11,
    color: colors.text.light,
    fontWeight: '700',
  },

  // Optional decorative backdrop behind the grid (only when art is configured)
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.12,
  },

  // Modal overlay and content
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: CENTER,
    alignItems: CENTER,
  },
  // Re-grounded on the showcase umber band; the per-stage colour is
  // applied inline as a left accent rail so each stage tints its own modal.
  modalContent: {
    width: '85%',
    maxHeight: '80%',
    backgroundColor: showcase.canvas,
    padding: spacing(2.5),
    borderRadius: radius.lg,
    borderLeftWidth: 4,
    position: 'relative',
    ...showcaseShadow,
  },

  // Close button
  closeButton: {
    position: 'absolute',
    top: spacing(1),
    right: spacing(1),
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: CENTER,
    justifyContent: CENTER,
    zIndex: 1,
  },
  closeText: {
    fontSize: 22,
    fontWeight: '600',
    color: onShowcase.soft,
  },

  // Stage color indicator dot
  colorDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: spacing(1),
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: CENTER,
    marginBottom: spacing(0.5),
    paddingRight: spacing(3),
  },

  // Title and subtitle
  modalTitle: {
    ...editorialType.title,
    fontSize: 22,
    color: onShowcase.primary,
  },
  modalSubtitle: {
    fontSize: 14,
    color: onShowcase.soft,
    marginBottom: spacing(1.5),
    fontStyle: 'italic',
  },

  // One-sentence progression read (replaces the disparate count list).
  progressionSentence: {
    fontFamily: editorialType.serif,
    fontSize: 15,
    lineHeight: 22,
    color: onShowcase.primary,
    marginBottom: spacing(1.5),
  },

  // Ranked headline stats row
  rankedStatsRow: {
    flexDirection: 'row',
    gap: spacing(1),
    marginBottom: spacing(1.5),
  },
  rankedStat: {
    flex: 1,
    backgroundColor: showcase.raised,
    borderRadius: radius.md,
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(0.5),
    alignItems: CENTER,
  },
  rankedStatValue: {
    fontSize: 20,
    fontWeight: '700',
    color: onShowcase.primary,
  },
  rankedStatLabel: {
    fontSize: 10,
    color: onShowcase.muted,
    textAlign: CENTER,
    marginTop: spacing(0.25),
  },

  // Progress bar
  progressContainer: {
    marginBottom: spacing(1.5),
  },
  progressLabel: {
    fontSize: 12,
    color: onShowcase.soft,
    marginBottom: spacing(0.5),
  },
  progressBar: {
    height: 8,
    backgroundColor: showcase.raised,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.sm,
  },

  // Rich metadata section
  metadataSection: {
    marginBottom: spacing(1.5),
  },
  metadataRow: {
    flexDirection: 'row',
    marginBottom: spacing(0.5),
  },
  metadataLabel: {
    fontSize: 12,
    color: onShowcase.soft,
    width: 100,
    fontWeight: '600',
  },
  metadataValue: {
    fontSize: 12,
    color: onShowcase.primary,
    flex: 1,
  },
  freeWillDescription: {
    fontSize: 12,
    color: onShowcase.soft,
    marginTop: spacing(0.5),
    lineHeight: 18,
    fontStyle: 'italic',
  },

  // Separator
  separator: {
    height: 1,
    backgroundColor: showcase.raised,
    marginVertical: spacing(1.5),
  },

  // Ranked actions: a full-width primary "Continue" stacked above two
  // secondary actions (visual hierarchy only — all three keep their handlers).
  actions: {
    gap: spacing(1),
  },
  primaryAction: {
    minHeight: touchTarget.minimum,
    paddingVertical: spacing(1.25),
    paddingHorizontal: spacing(1.5),
    borderRadius: radius.md,
    alignItems: CENTER,
    justifyContent: CENTER,
    backgroundColor: accent.primary,
  },
  primaryActionText: {
    fontSize: 15,
    color: colors.text.light,
    fontWeight: '700',
  },
  secondaryActionsRow: {
    flexDirection: 'row',
    gap: spacing(1),
  },
  secondaryAction: {
    flex: 1,
    minHeight: touchTarget.minimum,
    backgroundColor: showcase.raised,
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(1.5),
    borderRadius: radius.md,
    alignItems: CENTER,
    justifyContent: CENTER,
  },
  secondaryActionText: {
    fontSize: 13,
    color: onShowcase.primary,
    fontWeight: '600',
  },

  // History section
  historySection: {
    marginTop: spacing(1),
  },
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: CENTER,
    paddingVertical: spacing(1),
  },
  historyTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: onShowcase.primary,
  },
  historyToggle: {
    fontSize: 12,
    color: onShowcase.soft,
  },
  historyLoading: {
    paddingVertical: spacing(1.5),
    alignItems: CENTER,
  },
  historyEmpty: {
    fontSize: 12,
    color: onShowcase.soft,
    fontStyle: 'italic',
    paddingVertical: spacing(1),
    textAlign: CENTER,
  },
  historyError: {
    paddingVertical: spacing(1.5),
    alignItems: CENTER,
  },
  historyErrorText: {
    fontSize: 12,
    color: colors.danger,
    textAlign: CENTER,
    marginBottom: spacing(1),
  },
  historyRetry: {
    paddingVertical: spacing(0.5),
    paddingHorizontal: spacing(2),
  },
  historyRetryText: {
    fontSize: 12,
    fontWeight: '600',
    color: onShowcase.primary,
  },
  refreshBanner: {
    position: 'absolute',
    top: spacing(2),
    alignSelf: CENTER,
    maxWidth: '90%',
    flexDirection: 'row',
    alignItems: CENTER,
    backgroundColor: colors.mystical.overlay,
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(2),
    borderRadius: radius.md,
    ...shadows.medium,
  },
  refreshBannerText: {
    flex: 1,
    fontSize: 12,
    color: colors.text.light,
    marginRight: spacing(1.5),
  },
  refreshRetry: {
    paddingVertical: spacing(0.5),
    paddingHorizontal: spacing(1.5),
    borderRadius: radius.sm,
    backgroundColor: colors.secondary,
  },
  refreshRetryText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.light,
  },
  historySubheading: {
    fontSize: 12,
    fontWeight: '600',
    color: onShowcase.soft,
    marginTop: spacing(1),
    marginBottom: spacing(0.5),
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: CENTER,
    paddingVertical: spacing(0.5),
  },
  historyItemIcon: {
    fontSize: 16,
    marginRight: spacing(0.75),
  },
  historyItemName: {
    fontSize: 12,
    color: onShowcase.primary,
    flex: 1,
  },
  historyItemDetail: {
    fontSize: 11,
    color: onShowcase.soft,
  },
  goalBadges: {
    flexDirection: 'row',
    gap: 4,
    marginLeft: spacing(0.5),
  },
  goalBadge: {
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: CENTER,
    justifyContent: CENTER,
  },
  goalBadgeText: {
    fontSize: 8,
    fontWeight: '700',
    color: colors.text.light,
  },
});

export default styles;
