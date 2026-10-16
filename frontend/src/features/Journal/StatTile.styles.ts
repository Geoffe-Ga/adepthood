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
/**
 * The narrowest column a tile may take beside its neighbour (#3440). Two tiles
 * sit side by side only while each gets this much; below it (a phone at 200%
 * zoom) the row wraps and they stack, so every word of a stat or cue fits whole
 * and lines break only at spaces.
 */
export const STAT_TILE_MIN_COLUMN = 140;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
    marginTop: SPACING.lg,
  },
  tile: {
    // Equal shares while two fit (so the wide layout is unchanged), a full row each when not.
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: STAT_TILE_MIN_COLUMN,
    minWidth: 0,
    minHeight: touchTarget.minimum,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    // A warm paper tile lifted off the canvas by the shared card shadow.
    backgroundColor: surface.desk,
    ...surfaceShadow.card,
    justifyContent: 'center',
  },
  // A quiet label under the tile's one emphatic line (the stat itself).
  title: {
    ...editorialType.caption,
    color: ink.muted,
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
