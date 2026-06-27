/**
 * Styles for the long-form journal writing surface (journal-resonance).
 *
 * Deliberately separate from the old chat ``Journal.styles`` — this is an
 * editorial page (paper ground, serif body, reserved margin column), not a
 * message list. Tokens only.
 */
import { StyleSheet } from 'react-native';

import { colors, editorialType, journalLayout, spacing } from '@/design/tokens';

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.paper.background,
  },
  /** Centres the page and caps the reading measure on wide screens. */
  page: {
    flex: 1,
    flexDirection: 'row',
    width: '100%',
    maxWidth: journalLayout.pageMaxWidth + journalLayout.marginColumnWidth,
    alignSelf: 'center',
    paddingHorizontal: journalLayout.pageHorizontalPadding,
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
});

export default styles;
