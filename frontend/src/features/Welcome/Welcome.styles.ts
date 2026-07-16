import { StyleSheet } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  onShowcase,
  rhythm,
  showcase,
  surface,
  touchTarget,
} from '@/design/tokens';

/** Token-only styles for the program welcome (#836). */
export const welcomeStyles = StyleSheet.create({
  ground: {
    flex: 1,
    backgroundColor: surface.canvas,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: rhythm.screenPaddingH,
    paddingTop: rhythm.screenPaddingTop,
  },
  skip: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  skipLabel: {
    ...editorialType.action,
    color: accent.primary,
  },
  panel: {
    flex: 1,
    paddingHorizontal: rhythm.screenPaddingH,
    justifyContent: 'center',
  },
  hero: {
    gap: rhythm.blockGap,
  },
  eyebrow: {
    ...editorialType.caption,
    color: onShowcase.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: {
    ...editorialType.display,
    color: onShowcase.primary,
  },
  body: {
    ...editorialType.body,
    color: onShowcase.soft,
  },
  note: {
    ...editorialType.caption,
    color: onShowcase.muted,
    marginTop: rhythm.blockGap,
  },
  pillars: {
    gap: rhythm.blockGap,
    marginTop: rhythm.blockGap,
  },
  pillarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    minHeight: touchTarget.minimum,
  },
  pillarGlyph: {
    ...editorialType.title,
  },
  pillarName: {
    ...editorialType.body,
    color: onShowcase.primary,
  },
  footer: {
    paddingHorizontal: rhythm.screenPaddingH,
    paddingBottom: rhythm.heroPaddingV,
    gap: rhythm.blockGap,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  dot: {
    width: SPACING.sm,
    height: SPACING.sm,
    borderRadius: BORDER_RADIUS.circle,
    backgroundColor: surface.hairline,
  },
  dotActive: {
    backgroundColor: accent.primary,
  },
  nextButton: {
    minHeight: touchTarget.minimum,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: showcase.canvas,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextLabel: {
    ...editorialType.body,
    color: onShowcase.primary,
  },
});
