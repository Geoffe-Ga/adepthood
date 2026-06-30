// frontend/features/Map/Map.styles.ts

import { StyleSheet } from 'react-native';

import {
  accent,
  colors,
  editorialType,
  ink,
  radius,
  shadows,
  spacing,
  surface,
  touchTarget,
} from '../../design/tokens';

// --- Grid weights for the three cells of every stage row -------------------
// One responsive row grid is the single source of vertical truth: each stage
// row is [LeftCell | CenterCell | RightCell] with these flex weights (≈40/40/20),
// so the three columns are siblings in the same row and cannot drift.
const LEFT_FLEX = 2;
const CENTER_FLEX = 2;
const RIGHT_FLEX = 1;
const CENTER = 'center';

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
  },
  centerCell: {
    flex: CENTER_FLEX,
  },
  rightCell: {
    flex: RIGHT_FLEX,
    justifyContent: CENTER,
    paddingLeft: spacing(1),
  },

  // Left-column stage text block (also the tap target -0)
  stageBlock: {
    flex: 1,
    justifyContent: CENTER,
    paddingHorizontal: spacing(1),
    paddingVertical: spacing(0.5),
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

  // Right-column aspect label (wraps to fit — never clipped)
  rightLabelText: {
    fontFamily: editorialType.serif,
    fontSize: 15,
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
  // Gentle alternating band (replaces the old absolute grey half-bands): even
  // (Divine-Feminine) stages get a recessed tint, odd stages stay on canvas.
  cellFeminine: {
    backgroundColor: surface.sunken,
  },
  cellMasculine: {
    backgroundColor: surface.canvas,
  },
  // Legible current-stage marker (replaces the faint hotspot border).
  cellCurrent: {
    borderWidth: 2,
    borderColor: accent.primary,
    borderRadius: radius.sm,
  },
  arrowGlyph: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 26,
  },
  centerLabelRow: {
    flexDirection: 'row',
    alignItems: CENTER,
    justifyContent: CENTER,
    gap: spacing(0.5),
  },
  arrowLabelText: {
    fontWeight: '700',
    fontSize: 12,
    color: ink.soft,
    textAlign: CENTER,
    flexShrink: 1,
  },
  // Responsive title carried in the top stage rows' own grid cells (no fixed
  // 40px overlay): the serif ramp scales rather than overflowing the column.
  titleText: {
    ...editorialType.title,
    color: ink.primary,
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

  // Lock icon overlay for locked stages
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: CENTER,
    justifyContent: CENTER,
  },
  lockText: {
    fontSize: 14,
    color: ink.muted,
  },
  // Locked stages read recessed
  locked: {
    opacity: 0.4,
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
  modalContent: {
    width: '85%',
    maxHeight: '80%',
    backgroundColor: colors.secondary,
    padding: spacing(2.5),
    borderRadius: radius.lg,
    position: 'relative',
    ...shadows.large,
  },

  // Close button
  closeButton: {
    position: 'absolute',
    top: spacing(1),
    right: spacing(1),
    padding: spacing(0.5),
    zIndex: 1,
  },
  closeText: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text.light,
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
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.light,
  },
  modalSubtitle: {
    fontSize: 14,
    color: colors.mystical.transparentLight,
    marginBottom: spacing(1.5),
    fontStyle: 'italic',
  },

  // Progress bar
  progressContainer: {
    marginBottom: spacing(1.5),
  },
  progressLabel: {
    fontSize: 12,
    color: colors.mystical.transparentLight,
    marginBottom: spacing(0.5),
  },
  progressBar: {
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
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
    color: colors.mystical.transparentLight,
    width: 100,
    fontWeight: '600',
  },
  metadataValue: {
    fontSize: 12,
    color: colors.text.light,
    flex: 1,
  },
  freeWillDescription: {
    fontSize: 12,
    color: colors.mystical.transparentLight,
    marginTop: spacing(0.5),
    lineHeight: 18,
    fontStyle: 'italic',
  },

  // Separator
  separator: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginVertical: spacing(1.5),
  },

  // Quick action buttons
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing(1),
  },
  actionButton: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(1.5),
    borderRadius: radius.md,
    alignItems: CENTER,
  },
  actionText: {
    fontSize: 13,
    color: colors.text.light,
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
    color: colors.text.light,
  },
  historyToggle: {
    fontSize: 12,
    color: colors.mystical.transparentLight,
  },
  historyLoading: {
    paddingVertical: spacing(1.5),
    alignItems: CENTER,
  },
  historyEmpty: {
    fontSize: 12,
    color: colors.mystical.transparentLight,
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
    color: colors.text.light,
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
    color: colors.mystical.transparentLight,
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
    color: colors.text.light,
    flex: 1,
  },
  historyItemDetail: {
    fontSize: 11,
    color: colors.mystical.transparentLight,
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
