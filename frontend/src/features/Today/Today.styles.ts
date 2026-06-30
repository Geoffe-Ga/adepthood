import { StyleSheet } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  onShowcase,
  rhythm,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';

/** Token-only styles for the Today hub (#828). */
export const todayStyles = StyleSheet.create({
  heroEyebrow: {
    ...editorialType.caption,
    color: onShowcase.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: SPACING.xs,
  },
  heroGreeting: {
    ...editorialType.display,
    color: onShowcase.primary,
  },
  heroLead: {
    ...editorialType.note,
    color: onShowcase.soft,
    marginTop: SPACING.xs,
  },
  band: {
    ...surfaceShadow.card,
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: rhythm.blockGap,
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
  },
  bandTitle: {
    ...editorialType.note,
    color: ink.primary,
    fontWeight: '600',
  },
  bandValue: {
    ...editorialType.title,
    color: ink.primary,
    marginTop: SPACING.xs,
  },
  bandSubtitle: {
    ...editorialType.caption,
    color: ink.soft,
    marginTop: SPACING.xs,
  },
  bandCue: {
    ...editorialType.caption,
    color: accent.primary,
    fontWeight: '600',
    marginTop: SPACING.xs,
  },
});
