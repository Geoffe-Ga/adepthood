/**
 * Styles for the long-form journal writing surface (journal-resonance).
 *
 * Deliberately separate from the old chat ``Journal.styles`` — this is an
 * editorial page (paper ground, serif body, reserved margin column), not a
 * message list. Tokens only.
 */
import { StyleSheet } from 'react-native';

import {
  SPACING,
  colors,
  editorialType,
  journalLayout,
  journalSheet,
  paperShadow,
  spacing,
  touchTarget,
} from '@/design/tokens';

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
  },
  marginColumnNarrow: {
    width: '100%',
    paddingLeft: 0,
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
    // A growing multiline field; minHeight keeps the blank page inviting.
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
  marginCount: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
  },
  marginError: {
    ...editorialType.caption,
    color: colors.danger,
    paddingTop: spacing(1),
  },
  marginNoteSlot: {
    marginBottom: journalLayout.marginNoteGap,
  },
  controlLink: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    paddingTop: spacing(2),
  },
});

export default styles;
