/** Styles for the journal shelf (the landing list of entry "pages"). */
import { StyleSheet } from 'react-native';

import { BORDER_RADIUS, SPACING, colors, editorialType, spacing } from '@/design/tokens';

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.paper.background,
  },
  listContent: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.xxl,
    flexGrow: 1,
  },
  header: {
    paddingVertical: SPACING.md,
  },
  newEntry: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: SPACING.sm,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.primary,
  },
  newEntryLabel: {
    color: colors.text.light,
    fontSize: 16,
    fontWeight: '600',
  },
  card: {
    minHeight: 44,
    paddingVertical: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.paper.hairline,
  },
  cardTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  cardTitle: {
    ...editorialType.title,
    color: colors.paper.ink,
    flexShrink: 1,
  },
  cardDate: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    paddingLeft: SPACING.sm,
  },
  cardExcerpt: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingTop: spacing(0.5),
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.xxl,
  },
  emptyText: {
    ...editorialType.body,
    color: colors.paper.inkSoft,
    textAlign: 'center',
  },
  emptyError: {
    ...editorialType.body,
    color: colors.danger,
    textAlign: 'center',
  },
});

export default styles;
