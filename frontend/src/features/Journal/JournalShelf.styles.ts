/** Styles for the journal shelf (the landing list of entry "pages"). */
import { StyleSheet } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  paperShadow,
  spacing,
  touchTarget,
} from '@/design/tokens';

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.paper.desk, // shared desk ground (issue 01)
  },
  listContent: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
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
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    marginBottom: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    // The lifted page card: separation now comes from the gap + shadow between
    // floated cards, so the old borderBottom hairline is gone.
    backgroundColor: colors.paper.background,
    ...paperShadow.card,
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
  promptCard: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.lg,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    // Lifted onto the desk like the entry cards, but keeps its accent-bar
    // identity marking it as the weekly prompt.
    backgroundColor: colors.paper.background,
    borderLeftWidth: 3,
    borderLeftColor: colors.marginalia.theme,
    ...paperShadow.card,
  },
  promptLabel: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    textTransform: 'uppercase',
  },
  promptQuestion: {
    ...editorialType.title,
    color: colors.paper.ink,
    paddingTop: spacing(0.5),
  },
});

export default styles;
