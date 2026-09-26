/** Styles for the Promoted quotes screen — Candle & Ink tokens only. */
import { StyleSheet } from 'react-native';

import { SPACING, editorialType, ink, touchTarget } from '@/design/tokens';

const styles = StyleSheet.create({
  writeReview: {
    alignSelf: 'flex-start',
    marginBottom: SPACING.md,
  },
  section: {
    marginBottom: SPACING.lg,
  },
  sectionHeading: {
    ...editorialType.heading,
    color: ink.primary,
    marginBottom: SPACING.sm,
  },
  sectionNote: {
    ...editorialType.body,
    color: ink.soft,
  },
  loading: {
    alignSelf: 'center',
    paddingVertical: SPACING.lg,
  },
  emptyBlock: {
    paddingVertical: SPACING.xl,
  },
  emptyBody: {
    ...editorialType.body,
    color: ink.soft,
  },
  errorBlock: {
    paddingVertical: SPACING.sm,
    gap: SPACING.xs,
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
  removeLink: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  confirm: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  confirmPrompt: {
    ...editorialType.body,
    color: ink.primary,
  },
});

export default styles;
