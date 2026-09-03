/**
 * Styles for the long-form journal writing surface (journal-resonance).
 *
 * Deliberately separate from the old chat ``Journal.styles`` — this is an
 * editorial page (paper ground, serif body, reserved margin column), not a
 * message list. Tokens only.
 */
import { StyleSheet } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  journalLayout,
  journalSheet,
  paperShadow,
  spacing,
  touchTarget,
} from '@/design/tokens';

/** Warm left rule on the live quote preview, in dp — mirrors the reflection
 *  panel's pending-quote stripe so both promote surfaces read as one language. */
const PREVIEW_STRIPE_WIDTH = 3;

/**
 * Bottom inset reserving room for the floating "Get Resonance" button so page
 * content (the save hint, Finish link, and the stacked margin column on narrow
 * screens) never renders underneath it. Mirrors the button's own offset
 * (``bottom: SPACING.xl``) plus its height plus a small breathing gap.
 *
 * Applies to the writing surface ONLY, via ``pageWithFloatingAction``: the
 * reading view carries its resonance action in the page flow, so reserving the
 * band there would leave a dead strip under the last line of the entry.
 */
export const RESONANCE_BUTTON_CLEARANCE = SPACING.xl + touchTarget.minimum + SPACING.md;

/**
 * The floating writing timer's own box, in dp.
 *
 * The pill lays out as a fixed count of fixed-height rows — readout-and-controls,
 * plus the preset row an idle timer adds beneath it — rather than as one row of
 * chips left to wrap. That is what makes its height knowable here instead of a
 * function of how wide the phone is.
 *
 * It was not always. A single wrapping row of readout + four presets + Start
 * measures roughly 452dp in Georgia-Bold at the interactive text size, which is
 * wider than any phone: it reflowed to two rows on a 393-440dp handset and three
 * at 375dp, so a clearance that had reserved one 44dp row left the pill
 * overhanging the page by 40-92dp, painting an opaque, touch-absorbing box over
 * live marginalia.
 */
export const WRITING_TIMER_ROW_HEIGHT = touchTarget.minimum;
/** Readout-and-controls, plus the preset row the idle timer adds beneath it. */
export const WRITING_TIMER_MAX_ROWS = 2;
export const WRITING_TIMER_PILL_PADDING_V = SPACING.xs;
export const WRITING_TIMER_ROW_GAP = SPACING.xs;

/** The tallest the pill ever gets: every row it can show, at its full height. */
export const WRITING_TIMER_PILL_MAX_HEIGHT =
  WRITING_TIMER_PILL_PADDING_V * 2 +
  WRITING_TIMER_ROW_HEIGHT * WRITING_TIMER_MAX_ROWS +
  WRITING_TIMER_ROW_GAP * (WRITING_TIMER_MAX_ROWS - 1);

/**
 * Bottom inset for the writing surface, reserving BOTH floating affordances:
 * the resonance button in the lower band and the writing timer stacked a full
 * touch target above it.
 *
 * One inset covering the taller of the two, not a second one added beside it —
 * the timer sits at ``RESONANCE_BUTTON_CLEARANCE``, so the page has to clear
 * that plus the timer's own height plus the same breathing gap.
 */
export const WRITING_TIMER_CLEARANCE =
  RESONANCE_BUTTON_CLEARANCE + WRITING_TIMER_PILL_MAX_HEIGHT + SPACING.md;

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.paper.desk,
  },
  /** Padded desk so the deeper ground shows as a border around the lifted sheet. */
  desk: {
    flex: 1,
    paddingHorizontal: journalSheet.deskPaddingH,
    paddingTop: journalSheet.deskPaddingTop,
  },
  /** The floating paper sheet: lighter ground, soft warm shadow, rounded top. */
  sheet: {
    flex: 1,
    width: '100%',
    maxWidth: journalLayout.pageMaxWidth + journalLayout.marginColumnWidth,
    alignSelf: 'center',
    backgroundColor: colors.paper.background,
    borderTopLeftRadius: journalSheet.cornerRadius,
    borderTopRightRadius: journalSheet.cornerRadius,
    // A barely-there lit paper edge so the lifted sheet catches light at its
    // border (pairs with the shadow below; not a hard box outline).
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.sheetEdge,
    ...paperShadow.sheet,
  },
  sheetNarrow: {
    maxWidth: '100%',
  },
  pageScroll: {
    flex: 1,
  },
  pageScrollContent: {
    flexGrow: 1,
  },
  /** The two-column page inside the sheet (width cap + centring live on the sheet). */
  page: {
    flex: 1,
    flexDirection: 'row',
    width: '100%',
    paddingHorizontal: journalLayout.pageHorizontalPadding,
  },
  pageNarrow: {
    flexDirection: 'column',
  },
  /**
   * Only while something floats over the page: hold the band the floating
   * affordances cover. Sized to the topmost of them (the writing timer), so the
   * save hint, the Finish link and the stacked margin column clear both.
   */
  pageWithFloatingAction: {
    paddingBottom: WRITING_TIMER_CLEARANCE,
  },
  writingColumn: {
    flex: 1,
  },
  /** ScrollView content: grows to fill, so an empty page is still tappable. */
  writingColumnContent: {
    flexGrow: 1,
    paddingVertical: spacing(3),
    paddingRight: SPACING.md,
  },
  marginColumn: {
    width: journalLayout.marginColumnWidth,
    paddingLeft: journalLayout.marginNoteGap,
    paddingVertical: spacing(3),
    // Faint page-margin rule between the writing column and the marginalia —
    // intentionally hairline-light so it reads as a margin, not a divider.
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.paper.hairline,
  },
  marginColumnNarrow: {
    width: '100%',
    paddingLeft: 0,
    // When the marginalia stacks under the writing area, rule the top instead.
    borderLeftWidth: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.paper.hairline,
    paddingTop: spacing(2),
    marginTop: spacing(1),
  },
  titleInput: {
    ...editorialType.title,
    color: colors.paper.ink,
    paddingVertical: spacing(1),
    flexShrink: 1,
  },
  bodyInput: {
    ...editorialType.body,
    color: colors.paper.ink,
    paddingTop: spacing(1.5),
    // A growing multiline field; flexGrow fills the writing column's
    // available height while minHeight keeps the blank page inviting.
    flexGrow: 1,
    minHeight: 240,
    textAlignVertical: 'top',
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.paper.hairline,
    marginVertical: spacing(1),
  },
  /** The line under the body: save state on the left, live word count on the right. */
  writingFooter: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing(2),
  },
  saveStatusRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.xs,
  },
  saveRetry: {
    minHeight: touchTarget.minimum,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.sm,
  },
  saveRetryLabel: {
    ...editorialType.action,
    color: accent.primary,
  },
  /**
   * The page's quiet caption face, shared by every footer line that reports
   * state rather than offering an action: the save hint, the live word count
   * beside it, and the quote-inclusion hint. They sit at one weight on purpose
   * — the count is reference the writer glances at, not a target that should
   * out-shout the save state.
   */
  savedHint: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
  marginError: {
    ...editorialType.caption,
    color: colors.danger,
    paddingTop: spacing(1),
  },
  /**
   * A pass that found nothing to say. Soft ink on paper, deliberately not the
   * danger red of ``marginError`` beside it: the pass worked, and colouring a
   * considered "nothing yet" as a fault would read as the page scolding the
   * writer for what they wrote.
   */
  marginNotice: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
    paddingBottom: spacing(1),
  },
  /** Warm paper-toned notice (not a red panic block) for a failed entry load. */
  loadErrorBanner: {
    marginHorizontal: journalSheet.deskPaddingH,
    marginTop: spacing(1),
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: colors.paper.background,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.sheetEdge,
  },
  loadErrorText: {
    ...editorialType.caption,
    color: colors.danger,
  },
  marginNoteSlot: {
    marginBottom: journalLayout.marginNoteGap,
  },
  controlLink: {
    ...editorialType.action,
    color: accent.primary,
    paddingTop: spacing(2),
  },
  /**
   * The reading view's one action row, closing the reading column: the resonance
   * request as the primary, with Promote and Edit beside it. Wraps rather than
   * crowds so a narrow page keeps every control at its full touch target.
   */
  readActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.md,
    paddingTop: spacing(2),
  },
  /**
   * The page's exit row, above the sheet: the optional "Back to reading" return
   * and the always-present close, clustered at the trailing edge so the writer
   * finds one way out wherever they arrived from.
   */
  entryExitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: SPACING.md,
    paddingHorizontal: journalSheet.deskPaddingH,
  },
  /** Read-mode quote affordances (Promote / Remove promotion): 44dp touch floor. */
  quoteActionButton: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
  },
  /** Row holding the Promote / Cancel actions under the span-selection field. */
  quoteSelectActions: {
    flexDirection: 'row',
    gap: SPACING.md,
    paddingTop: spacing(1),
    alignItems: 'center',
  },
  /** Warm guiding line above the field: how to select a passage to promote. */
  quoteSelectInstruction: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingBottom: spacing(1),
  },
  /** Highlighted card echoing the chosen passage back before it is promoted. */
  quoteSelectPreview: {
    backgroundColor: colors.paper.quoteHighlight,
    borderRadius: BORDER_RADIUS.md,
    borderLeftWidth: PREVIEW_STRIPE_WIDTH,
    borderLeftColor: accent.primary,
    padding: SPACING.md,
    marginTop: spacing(1),
  },
  quoteSelectPreviewText: {
    ...editorialType.note,
    color: colors.paper.ink,
  },
  /** Warm (not alarming) nudge shown when confirm is tapped with no selection. */
  quoteSelectHint: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
  /** Quiet in-flight line shown under the body while a promote POST is pending. */
  promotionInflight: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
  /** Transient success confirmation ("Promoted") after a span is raised. */
  promotionSuccess: {
    ...editorialType.note,
    color: colors.successText,
    paddingTop: spacing(1),
  },
  /** Legible (note-sized) error notice for a failed promote/remove. */
  promotionErrorText: {
    ...editorialType.note,
    color: colors.danger,
    paddingTop: spacing(1),
  },
  /** Anchored card revealed beside a tapped promoted span, offering removal. */
  promotionRemoveCard: {
    backgroundColor: colors.paper.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginTop: spacing(1),
  },
  /** Echo of the tapped quote's text inside the remove card. */
  promotionRemoveQuote: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    fontStyle: 'italic',
    paddingBottom: spacing(1),
  },
  /** Privacy tier chooser block above the growing body. */
  privacyTierControl: {
    paddingBottom: spacing(1),
  },
  privacyTierRow: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  /** Each tier option; both min dims hold the touch target at the 44dp floor. */
  privacyTierOption: {
    flex: 1,
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
  },
  privacyTierOptionSelected: {
    backgroundColor: colors.paper.anchorHighlight,
    borderColor: colors.paper.inkSoft,
  },
  privacyTierLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
  privacyTierLabelSelected: {
    color: colors.paper.ink,
  },
  privacyTierExplainer: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
  /** Reason line shown beside the disabled resonance button for intimate entries. */
  privacyResonanceReason: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    textAlign: 'center',
    paddingHorizontal: SPACING.xl,
    paddingBottom: SPACING.sm,
  },
  /** Optional chord (Aspect) tagging block above the growing body. */
  aspectChordControl: {
    paddingBottom: spacing(1),
  },
  /** The collapsed, declinable trigger that reveals the Aspect chips. */
  aspectChordTrigger: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  aspectChordTriggerLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
  /** Section label above a row of Aspect chips (primary / secondary). */
  aspectChordSectionLabel: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
  /** Wrapping row of Aspect chips. */
  aspectChordRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
  },
  /**
   * A voice of the chord that has been chosen, folded onto one line: its label,
   * the chosen chip, and the affordance that reopens the row. Folding is what
   * keeps a named chord from holding nineteen chips open in the writing column.
   */
  aspectChordChosenRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  /** A single Aspect chip; min dims hold the 44dp touch-target floor. */
  aspectChordChip: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
  },
  /**
   * The chosen chip. Its fill is this stage's own colour, applied at render from
   * the shared palette, so only the ink border it gains lives here.
   */
  aspectChordChipSelected: {
    borderColor: colors.paper.ink,
  },
  aspectChordChipLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
  /** Row holding the chord-level affordances (Clear, Collapse) on one line. */
  aspectChordActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  /** A chord affordance: Clear, Collapse, or a row's Change. 44dp touch floor. */
  aspectChordAction: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  aspectChordActionLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
});

export default styles;
