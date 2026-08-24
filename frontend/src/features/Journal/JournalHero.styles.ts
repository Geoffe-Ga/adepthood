import { StyleSheet } from 'react-native';

import { SPACING, editorialType, onShowcase, touchTarget } from '@/design/tokens';

/** Token-only styles for the journal showcase hero. */
export const journalHeroStyles = StyleSheet.create({
  // Sentence case, untracked: the tracked small-caps eyebrow belongs to the
  // shelf's recency spine alone, and repeating it here made the hero a header
  // stacked on a header.
  eyebrow: {
    ...editorialType.caption,
    color: onShowcase.muted,
    marginBottom: SPACING.xs,
  },
  greeting: {
    ...editorialType.title,
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
