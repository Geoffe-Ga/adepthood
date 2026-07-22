/** Styles for the two-up journal stat tiles (Candle & Ink paper tiles). */
import { StyleSheet } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';

/** Skeleton block sized to stand in for a single line of stat text. */
export const SKELETON_WIDTH = '60%';
export const SKELETON_HEIGHT = 20;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginTop: SPACING.lg,
  },
  tile: {
    flex: 1,
    minHeight: touchTarget.minimum,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    // A warm paper tile lifted off the canvas by the shared card shadow.
    backgroundColor: surface.desk,
    ...surfaceShadow.card,
    justifyContent: 'center',
  },
  title: {
    ...editorialType.caption,
    color: ink.muted,
    textTransform: 'uppercase',
  },
  stat: {
    ...editorialType.heading,
    color: ink.primary,
    marginTop: SPACING.xs,
  },
  cue: {
    ...editorialType.action,
    color: accent.primary,
    marginTop: SPACING.xs,
  },
});

export default styles;
