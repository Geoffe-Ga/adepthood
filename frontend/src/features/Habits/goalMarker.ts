import type { ViewStyle } from 'react-native';

/** The three goal tiers shown as star markers on a habit's progress bar. */
export type TierType = 'low' | 'clear' | 'stretch';

/** Human label per tier, shared by the habit tile and the goal modal. */
export const TIER_LABELS: Record<TierType, string> = {
  low: 'Low Grit',
  clear: 'Clear Goal',
  stretch: 'Stretch Goal',
};

/**
 * Center a marker of the given size over its position on the bar, clamped at
 * the edges (0% sits flush-left, 100% flush-right, everything else centered).
 */
export const centeredTranslateX = (clamped: number, size: number): number => {
  if (clamped === 0) return 0;
  return clamped === 100 ? -size : -size / 2;
};

/**
 * The tier-tooltip bubble box (parchment fill + a tier-coloured border). The
 * border colour is passed in so each caller can resolve it from its own palette.
 * The tooltip *text* style is intentionally not shared — the tile scales its
 * font with the tile scale while the modal uses a fixed size.
 */
export const tooltipBoxStyle = (color: string): ViewStyle => ({
  position: 'absolute',
  bottom: 16,
  backgroundColor: '#fffdf7',
  borderWidth: 1,
  borderColor: color,
  borderRadius: 4,
  paddingHorizontal: 4,
  paddingVertical: 2,
});
