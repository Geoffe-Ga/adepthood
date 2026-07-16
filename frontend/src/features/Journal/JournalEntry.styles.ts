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
 */
export const RESONANCE_BUTTON_CLEARANCE = SPACING.xl + touchTarget.minimum + SPACING.md;

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
  /** The two-column page inside the sheet (width cap + centring live on the sheet). */
  page: {
    flex: 1,
    flexDirection: 'row',
    width: '100%',
    paddingHorizontal: journalLayout.pageHorizontalPadding,
    paddingBottom: RESONANCE_BUTTON_CLEARANCE,
  },
  pageNarrow: {
    flexDirection: 'column',
  },
  writingColumn: {
    flex: 1,
  },
  /** ScrollView content: grows to fill, so an empty page is still tappable. */
  writingColumnContent: {
    flexGrow: 1,
    paddingVertical: spacing(3),
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
  aspectChordChipSelected: {
    backgroundColor: colors.paper.anchorHighlight,
    borderColor: colors.paper.inkSoft,
  },
  aspectChordChipLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
  aspectChordChipLabelSelected: {
    color: colors.paper.ink,
  },
  /** The clear affordance that resets the chord to untagged. */
  aspectChordClear: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  aspectChordClearLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
});

export default styles;
