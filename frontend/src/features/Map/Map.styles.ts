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
  uiType,
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
// A corner's two edges: the left corner's content starts, the right one's ends.
const FLEX_START = 'flex-start';
const FLEX_END = 'flex-end';

// --- Soft grid rules -------------------------------------------------------
// The Map is a table, and a table reads as one through its rules: gentle
// horizontal lines between the aspect bands (and the stacked stages within
// them) and vertical lines between the three columns. Drawn as the thinnest
// hairline the platform can render, in the faint warm rule colour, so they
// whisper the grid over the parchment rather than caging it.
const GRID_LINE_COLOR = surface.hairline;
const GRID_LINE_WIDTH = StyleSheet.hairlineWidth;

// --- Keeping the stage annotations off the wave (#2657) ----------------------
// Through a stage's band the wave keeps to its return pole's half of the
// center column and crosses the centreline only at the band edges; the half on
// the label's side is the one the stroke leaves free. A stage's locked note
// (padlock + unlock estimate) is confined to that half, stopping a keep-out
// short of the centreline, and no band may shrink below its content, so a short
// window scrolls the table rather than painting one stage onto the next.

/**
 * The share of a center cell a stage's locked note may use: the half on its
 * label's side, which the wave leaves free through the band.
 */
export const ANNOTATION_LANE_WIDTH = '50%';

/**
 * Clearance between a lane and the column centreline, which the wave's stroke
 * (plus its converging apex offset near the top) can reach.
 */
export const WAVE_KEEP_OUT = spacing(0.5);

/**
 * A flex item's content-based minimum height. react-native-web gives every View
 * min-height 0, so a grid shorter than its content squeezed each band below
 * its own text and painted one stage onto the next; restoring the content
 * minimum on the bands makes a short window scroll instead. (The grid needs
 * none: inside the scroll content its height is indefinite, so it already
 * sizes to its bands.)
 * (Yoga has no content minimum and ignores it on native.)
 */
export const FIT_CONTENT = 'auto';

// --- The type ramp (#2960) -------------------------------------------------
// Every size below is a Candle & Ink step. A StyleSheet cannot see the window,
// so each is one legal at the phone and the desktop ramp alike.
/** Metadata and fine print: ``editorialType.caption``. */
const CAPTION_SIZE = editorialType.caption.fontSize;
/** Screen-state copy and the celebration: ``editorialType.note``. */
const NOTE_SIZE = editorialType.note.fontSize;
/** Tappable text and the lead line of a block: the interactive floor. */
const ACTION_SIZE = uiType.button.fontSize;
/** The modal's title and its close glyph: ``editorialType.heading``. */
const HEADING_SIZE = editorialType.heading.fontSize;
/** A round badge sized to hold one caption glyph on its own line height. */
const BADGE_DIAMETER = editorialType.caption.lineHeight;

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
    fontSize: NOTE_SIZE,
    marginTop: spacing(1),
  },
  errorText: {
    color: colors.danger,
    fontSize: NOTE_SIZE,
    textAlign: CENTER,
    paddingHorizontal: spacing(2),
  },
  // A load that returned nothing is not a failure, so the headline reads in
  // plain ink rather than the alarm colour; the hint/retry are shared.
  emptyText: {
    color: ink.primary,
    fontSize: NOTE_SIZE,
    textAlign: CENTER,
    paddingHorizontal: spacing(2),
  },
  // The human "what to do next" line under the verbatim server message.
  errorHint: {
    color: ink.muted,
    fontSize: NOTE_SIZE,
    lineHeight: 20,
    textAlign: CENTER,
    marginTop: spacing(1),
    paddingHorizontal: spacing(2),
  },
  // Stacked under the message in the centered layout rather than sitting inline
  // like the refresh banner's retry, so it needs its own top margin.
  errorRetry: {
    marginTop: spacing(2),
    minHeight: touchTarget.minimum,
    justifyContent: CENTER,
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(2),
    borderRadius: radius.sm,
    backgroundColor: accent.primary,
  },
  errorRetryText: {
    ...editorialType.action,
    color: accent.onPrimary,
    textAlign: CENTER,
  },

  // --- The single responsive row grid --------------------------------------
  // The grid and Begin again scroll together below the fixed journey read; the
  // content stretches to the viewport so the grid still fills it when it fits.
  gridScroll: {
    flex: 1,
  },
  gridScrollContent: {
    flexGrow: 1,
  },
  grid: {
    flex: 1,
  },
  // One stage row; flex weight set inline to stageNumbers.length so a paired
  // row is twice the height of a single-stage row, never shorter than its text.
  groupRow: {
    flexDirection: 'row',
    minHeight: FIT_CONTENT,
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

  // Right-column aspect label: serif face and ink only. Font size and line
  // height are computed per-fit at render time (fitRightLabel + the shared
  // line-height ratio), so a long word shrinks to one line rather than being
  // pinned to a fixed size.
  rightLabelText: {
    fontFamily: editorialType.serif,
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
  // --- The glass magnifier lens (the "you are here" box, grown up) ----------
  // A translucent pill floating over the center column. Width / height /
  // borderRadius and its transform are computed per-layout in the component;
  // here lives only the glass treatment itself.
  magnifier: {
    position: 'absolute',
    top: 0,
    left: 0,
    borderWidth: 2,
    borderColor: accent.strong,
    backgroundColor: colors.mystical.glowLight,
    alignItems: CENTER,
    justifyContent: CENTER,
    ...shadows.medium,
  },
  // Clipping bowl for the magnified artwork + frost wash; radius set inline to
  // match the pill so the magnified wave never bleeds past the glass edge.
  magnifierClip: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
  },
  // Frost wash that rises while the lens is in motion (the "blur" read on
  // native; the web build adds a true backdrop blur on the pill itself).
  magnifierFrost: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.mystical.transparentLight,
  },
  magnifierCaption: {
    alignItems: CENTER,
    paddingHorizontal: spacing(1),
  },
  magnifierHeadline: {
    fontFamily: editorialType.serif,
    fontSize: ACTION_SIZE,
    fontWeight: '700',
    color: ink.primary,
  },
  magnifierDetail: {
    fontSize: CAPTION_SIZE,
    color: ink.soft,
  },
  // "You are here" chip riding the lens when it rests on the current stage.
  youAreHere: {
    marginBottom: spacing(0.25),
    paddingVertical: spacing(0.25),
    paddingHorizontal: spacing(0.5),
    borderRadius: radius.sm,
    backgroundColor: accent.strong,
  },
  youAreHereText: {
    fontSize: CAPTION_SIZE,
    fontWeight: '700',
    color: colors.text.light,
    letterSpacing: 0.5,
  },
  // Aspect-label block hugging a center-cell corner (opposite the wave's
  // return pole). The block spans the cell and ``alignItems`` groups the word +
  // its locked note against the edge, in flow (no absolute overlay); spanning
  // is what lets the note's lane resolve to half the cell.
  labelBlockLeft: {
    alignSelf: 'stretch',
    alignItems: FLEX_START,
  },
  labelBlockRight: {
    alignSelf: 'stretch',
    alignItems: FLEX_END,
  },
  // Measured wrapper around the label block: stretches to the center cell's
  // full width (like titleFit) so a label that already fits is never shrunk.
  labelFit: {
    alignSelf: 'stretch',
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
  // Thin connector between a stage and the one below it.
  connector: {
    width: 2,
    height: spacing(1),
    marginTop: spacing(0.25),
    backgroundColor: surface.hairline,
  },

  // A locked stage's note: padlock + unlock estimate in one row, confined to
  // the label side's half of the cell and a keep-out short of the centreline,
  // with the padlock on the cell's outer edge (mirrored per corner).
  lockedNote: {
    width: ANNOTATION_LANE_WIDTH,
    flexDirection: 'row',
    alignItems: CENTER,
    gap: spacing(0.25),
    marginTop: spacing(0.25),
  },
  lockedNoteLeft: {
    alignSelf: FLEX_START,
    justifyContent: FLEX_START,
    paddingRight: WAVE_KEEP_OUT,
  },
  lockedNoteRight: {
    alignSelf: FLEX_END,
    justifyContent: FLEX_END,
    paddingLeft: WAVE_KEEP_OUT,
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
  // Unlock estimate ("Unlocks in N days") beside the padlock in the locked
  // note. It wraps inside the lane rather than spanning the cell, and its text
  // aligns to the same corner via the left/right variants below, so the copy
  // reads away from the wave strand.
  unlockTimeline: {
    flexShrink: 1,
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
    fontSize: NOTE_SIZE,
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
    fontSize: ACTION_SIZE,
    fontWeight: '700',
    color: ink.primary,
    letterSpacing: 0.5,
  },
  // Subtle "Cycle N" caption in the journey header (a wheel, not a rank).
  cycleIndicator: {
    fontFamily: editorialType.serif,
    fontSize: CAPTION_SIZE,
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
    fontSize: ACTION_SIZE,
    fontWeight: '700',
    color: onShowcase.primary,
    textAlign: CENTER,
  },
  beginAgainBody: {
    fontFamily: editorialType.serif,
    fontSize: CAPTION_SIZE,
    lineHeight: 20,
    color: onShowcase.soft,
    textAlign: CENTER,
  },

  // Completed stage checkmark, pinned to the bottom of the label's corner:
  // the top of that corner is the word's, and the other side is the wave's.
  completedBadge: {
    position: 'absolute',
    bottom: spacing(0.25),
    width: BADGE_DIAMETER,
    height: BADGE_DIAMETER,
    borderRadius: BADGE_DIAMETER / 2,
    backgroundColor: colors.success,
    alignItems: CENTER,
    justifyContent: CENTER,
  },
  completedBadgeLeft: {
    left: spacing(0.25),
  },
  completedBadgeRight: {
    right: spacing(0.25),
  },
  completedBadgeText: {
    fontSize: CAPTION_SIZE,
    color: colors.text.light,
    fontWeight: '700',
  },

  // Optional decorative backdrop behind the grid (only when art is configured)
  backdrop: {
    ...StyleSheet.absoluteFill,
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
    fontSize: HEADING_SIZE,
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
    ...editorialType.heading,
    color: onShowcase.primary,
  },
  modalSubtitle: {
    fontSize: ACTION_SIZE,
    color: onShowcase.soft,
    marginBottom: spacing(1.5),
    fontStyle: 'italic',
  },

  // One-sentence progression read.
  progressionSentence: {
    fontFamily: editorialType.serif,
    fontSize: ACTION_SIZE,
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
    fontSize: HEADING_SIZE,
    fontWeight: '700',
    color: onShowcase.primary,
  },
  rankedStatLabel: {
    fontSize: CAPTION_SIZE,
    color: onShowcase.muted,
    textAlign: CENTER,
    marginTop: spacing(0.25),
  },

  // Progress bar
  progressContainer: {
    marginBottom: spacing(1.5),
  },
  progressLabel: {
    fontSize: CAPTION_SIZE,
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
    fontSize: CAPTION_SIZE,
    color: onShowcase.soft,
    width: 100,
    fontWeight: '600',
  },
  metadataValue: {
    fontSize: CAPTION_SIZE,
    color: onShowcase.primary,
    flex: 1,
  },
  freeWillDescription: {
    fontSize: CAPTION_SIZE,
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
    fontSize: ACTION_SIZE,
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
    fontSize: ACTION_SIZE,
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
    fontSize: ACTION_SIZE,
    fontWeight: '700',
    color: onShowcase.primary,
  },
  historyToggle: {
    fontSize: ACTION_SIZE,
    color: onShowcase.soft,
  },
  historyStatus: {
    paddingVertical: spacing(1.5),
    alignItems: CENTER,
  },
  historyEmpty: {
    fontSize: CAPTION_SIZE,
    color: onShowcase.soft,
    fontStyle: 'italic',
    paddingVertical: spacing(1),
    textAlign: CENTER,
  },
  historyErrorText: {
    fontSize: CAPTION_SIZE,
    color: colors.danger,
    textAlign: CENTER,
    marginBottom: spacing(1),
  },
  historyRetry: {
    paddingVertical: spacing(0.5),
    paddingHorizontal: spacing(2),
  },
  historyRetryText: {
    ...uiType.button,
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
    fontSize: CAPTION_SIZE,
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
    ...uiType.button,
    color: colors.text.light,
  },
  historySubheading: {
    fontSize: CAPTION_SIZE,
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
    fontSize: ACTION_SIZE,
    marginRight: spacing(0.75),
  },
  historyItemName: {
    fontSize: CAPTION_SIZE,
    color: onShowcase.primary,
    flex: 1,
  },
  historyItemDetail: {
    fontSize: CAPTION_SIZE,
    color: onShowcase.soft,
  },
  goalBadges: {
    flexDirection: 'row',
    gap: 4,
    marginLeft: spacing(0.5),
  },
  goalBadge: {
    width: BADGE_DIAMETER,
    height: BADGE_DIAMETER,
    borderRadius: BADGE_DIAMETER / 2,
    alignItems: CENTER,
    justifyContent: CENTER,
  },
  goalBadgeText: {
    fontSize: CAPTION_SIZE,
    fontWeight: '700',
    color: colors.text.light,
  },
});

export default styles;
