import React from 'react';
import Svg, { Polygon } from 'react-native-svg';

/**
 * Unlabeled goal-tier star markers.
 *
 * Each habit goal tier is denoted by a star whose point-count encodes the
 * tier — a 4-pointed star for Low Grit, a 5-pointed star for Clear Goal, and
 * a 10-pointed star for Stretch Goal — so the markers read at a glance
 * without the old "LG / CG / SG" text labels.
 *
 * The visual style intentionally matches the bottom-tab navigation icons
 * (``lucide-react-native``): a 24×24 viewBox, stroke-only outline, 2dp
 * stroke, and rounded joins. ``lucide`` ships no 4- or 10-pointed star, so
 * the shape is generated here from first principles while keeping that same
 * outlined look.
 */

export type TierStarTier = 'low' | 'clear' | 'stretch';

/** Spoken tier name, used as the default screen-reader label for each star. */
export const TIER_LABELS: Record<TierStarTier, string> = {
  low: 'Low Grit',
  clear: 'Clear Goal',
  stretch: 'Stretch Goal',
};

/** Point count per tier — the sole differentiator between the three stars. */
const TIER_POINTS: Record<TierStarTier, number> = {
  low: 4,
  clear: 5,
  stretch: 10,
};

/**
 * Inner-radius ratio (valley depth) per tier. Sharper for low point counts so
 * the 4- and 5-pointed stars read as crisp stars; shallower for the 10-pointed
 * star so it reads as a full star/sunburst rather than an unreadable spike
 * cluster.
 */
const TIER_INNER_RATIO: Record<TierStarTier, number> = {
  low: 0.4,
  clear: 0.382,
  stretch: 0.72,
};

// Match the lucide 24×24 grid so these sit alongside the tab icons cleanly.
const VIEWBOX = 24;
const CENTER = VIEWBOX / 2;
// Leave a 2dp margin inside the viewBox so the 2dp stroke is never clipped.
const OUTER_RADIUS = 10;
const STROKE_WIDTH = 2;
const QUARTER_TURN = Math.PI / 2;
const COORD_PRECISION = 3;

/** Build the alternating outer/inner vertex list for an N-pointed star. */
const buildStarPoints = (points: number, innerRatio: number): string => {
  const innerRadius = OUTER_RADIUS * innerRatio;
  const angleStep = Math.PI / points;
  const coords: string[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? OUTER_RADIUS : innerRadius;
    // Start at the top (−90°) so every star points straight up.
    const angle = -QUARTER_TURN + i * angleStep;
    const x = CENTER + radius * Math.cos(angle);
    const y = CENTER + radius * Math.sin(angle);
    coords.push(`${x.toFixed(COORD_PRECISION)},${y.toFixed(COORD_PRECISION)}`);
  }
  return coords.join(' ');
};

const STAR_POINTS: Record<TierStarTier, string> = {
  low: buildStarPoints(TIER_POINTS.low, TIER_INNER_RATIO.low),
  clear: buildStarPoints(TIER_POINTS.clear, TIER_INNER_RATIO.clear),
  stretch: buildStarPoints(TIER_POINTS.stretch, TIER_INNER_RATIO.stretch),
};

const DEFAULT_SIZE = 14;

interface TierStarProps {
  tier: TierStarTier;
  color: string;
  size?: number;
  testID?: string;
  /** Screen-reader label; defaults to the spoken tier name so the star is
   * never announced as a bare "image" the way the old text label was read. */
  accessibilityLabel?: string;
}

/** Outlined, tier-encoding star marker (see module docstring). */
export const TierStar = ({
  tier,
  color,
  size = DEFAULT_SIZE,
  testID,
  accessibilityLabel,
}: TierStarProps) => (
  <Svg
    width={size}
    height={size}
    viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
    testID={testID}
    accessibilityRole="image"
    accessibilityLabel={accessibilityLabel ?? TIER_LABELS[tier]}
  >
    <Polygon
      points={STAR_POINTS[tier]}
      fill="none"
      stroke={color}
      strokeWidth={STROKE_WIDTH}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </Svg>
);

export default TierStar;
