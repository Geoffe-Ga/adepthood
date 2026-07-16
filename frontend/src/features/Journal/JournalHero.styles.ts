import { StyleSheet } from 'react-native';

import { SPACING, editorialType, onShowcase, touchTarget } from '@/design/tokens';

const EYEBROW_TRACKING = 1;

/** Token-only styles for the journal showcase hero. */
export const journalHeroStyles = StyleSheet.create({
  eyebrow: {
    ...editorialType.caption,
    color: onShowcase.muted,
    textTransform: 'uppercase',
    letterSpacing: EYEBROW_TRACKING,
    marginBottom: SPACING.xs,
  },
  greeting: {
    ...editorialType.display,
    color: onShowcase.primary,
  },
  position: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    marginTop: SPACING.xs,
  },
  positionText: {
    ...editorialType.note,
    color: onShowcase.soft,
  },
  positionCue: {
    ...editorialType.action,
    color: onShowcase.muted,
    marginTop: SPACING.xs,
  },
});
