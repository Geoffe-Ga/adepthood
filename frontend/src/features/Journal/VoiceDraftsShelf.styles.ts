/** Styles for the Voice Drafts shelf — the writer's letters as a body of work. */
import { StyleSheet } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  editorialType,
  ink,
  rhythm,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: rhythm.bottomFadeHeight,
    flexGrow: 1,
  },
  // A warm paper tile lifted off the canvas by the shared card shadow, so the
  // shelf reads as pages set down rather than rows in a table.
  card: {
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    marginBottom: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: surface.desk,
    ...surfaceShadow.card,
  },
  // The words the letter grew from, set as the quotation they are.
  cardAnchor: {
    ...editorialType.body,
    color: ink.primary,
  },
  cardExcerpt: {
    ...editorialType.caption,
    color: ink.soft,
    marginTop: SPACING.xs,
  },
  cardDate: {
    ...editorialType.caption,
    color: ink.muted,
    marginTop: SPACING.xs,
  },
  loading: {
    alignSelf: 'center',
    paddingVertical: SPACING.lg,
  },
  emptyBlock: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: SPACING.xl,
    gap: SPACING.sm,
  },
  emptyTitle: {
    ...editorialType.title,
    color: ink.primary,
  },
  emptyBody: {
    ...editorialType.body,
    color: ink.soft,
  },
  errorBlock: {
    paddingVertical: SPACING.lg,
    gap: SPACING.sm,
  },
  errorText: {
    ...editorialType.body,
    color: ink.soft,
  },
  actionRow: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingVertical: SPACING.sm,
  },
  actionText: {
    ...editorialType.action,
    color: ink.muted,
  },
  letterCard: {
    maxHeight: '80%',
  },
  letterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  letterClose: {
    ...editorialType.action,
    minWidth: touchTarget.minimum,
    textAlign: 'right',
    color: ink.muted,
  },
  letterDate: {
    ...editorialType.caption,
    color: ink.muted,
  },
  letterQuote: {
    ...editorialType.title,
    color: ink.primary,
    paddingVertical: SPACING.md,
  },
  letterScroll: {
    paddingTop: SPACING.xs,
  },
  letterBody: {
    ...editorialType.body,
    color: ink.primary,
  },
  letterFooter: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingTop: SPACING.md,
  },
  letterFooterText: {
    ...editorialType.action,
    color: ink.muted,
  },
});

export default styles;
