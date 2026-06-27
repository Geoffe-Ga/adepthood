import React, { useId } from 'react';
import Svg, { Defs, FeDropShadow, Filter, LinearGradient, Polygon, Stop } from 'react-native-svg';

import { colors } from '../design/tokens';

/**
 * Unlabeled goal-tier star markers.
 *
 * Each habit goal tier is denoted by a star whose point-count encodes the
 * tier — a 4-pointed star for Low Grit, a 5-pointed star for Clear Goal, and
 * a 10-pointed star for Stretch Goal — so the markers read at a glance.
 *
 * The stars are tier-agnostic greyscale. While a tier is unmet the star is a
 * stroke-only outline in darkish grey (same lucide-style 24×24 / rounded-join
 * look as the bottom-tab icons). Once the tier is achieved (``met``) it fills
 * with a greyscale gradient and gains a white border glow. ``lucide`` ships no
 * 4- or 10-pointed star, so the shape is generated here from first principles.
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
// Leave a 2dp margin inside the viewBox so the stroke + glow are never clipped.
const OUTER_RADIUS = 10;
const STROKE_WIDTH = 2;
// Thinner border on the filled (met) star so the white edge reads as a rim, not a slab.
const MET_STROKE_WIDTH = 1.5;
const GLOW_BLUR = 1.2;
const GLOW_OPACITY = 0.9;
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
  /** When true the star is filled (greyscale gradient + white glow); otherwise outline-only. */
  met?: boolean;
  size?: number;
  testID?: string;
  /** Screen-reader label; defaults to the spoken tier name so the star is
   * never announced as a bare "image" the way the old text label was read. */
  accessibilityLabel?: string;
}

const svgProps = (size: number, testID: string | undefined, label: string) => ({
  width: size,
  height: size,
  viewBox: `0 0 ${VIEWBOX} ${VIEWBOX}`,
  testID,
  accessibilityRole: 'image' as const,
  accessibilityLabel: label,
});

interface StarVariantProps {
  tier: TierStarTier;
  size: number;
  testID: string | undefined;
  label: string;
}

/** Unmet state: darkish-grey, stroke-only outline. */
const OutlineStar = ({ tier, size, testID, label }: StarVariantProps) => (
  <Svg {...svgProps(size, testID, label)}>
    <Polygon
      points={STAR_POINTS[tier]}
      fill="none"
      stroke={colors.starMarker.outline}
      strokeWidth={STROKE_WIDTH}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </Svg>
);

/** Met state: greyscale gradient fill with a white border glow. */
const MetStar = ({ tier, size, testID, label }: StarVariantProps) => {
  // Unique, SVG-id-safe suffix so multiple stars' gradients/filters never
  // collide (ids are document-global on web). useId is stable across renders.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const gradientId = `tierStarFill-${uid}`;
  const glowId = `tierStarGlow-${uid}`;
  return (
    <Svg {...svgProps(size, testID, label)}>
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={colors.starMarker.gradientFrom} />
          <Stop offset="1" stopColor={colors.starMarker.gradientTo} />
        </LinearGradient>
        <Filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
          <FeDropShadow
            dx="0"
            dy="0"
            stdDeviation={GLOW_BLUR}
            floodColor={colors.starMarker.glow}
            floodOpacity={GLOW_OPACITY}
          />
        </Filter>
      </Defs>
      <Polygon
        points={STAR_POINTS[tier]}
        fill={`url(#${gradientId})`}
        stroke={colors.starMarker.glow}
        strokeWidth={MET_STROKE_WIDTH}
        strokeLinejoin="round"
        strokeLinecap="round"
        filter={`url(#${glowId})`}
      />
    </Svg>
  );
};

/** Tier-encoding star marker: greyscale outline when unmet, filled + glowing when met. */
export const TierStar = ({
  tier,
  met = false,
  size = DEFAULT_SIZE,
  testID,
  accessibilityLabel,
}: TierStarProps) => {
  const variantProps: StarVariantProps = {
    tier,
    size,
    testID,
    label: accessibilityLabel ?? TIER_LABELS[tier],
  };
  return met ? <MetStar {...variantProps} /> : <OutlineStar {...variantProps} />;
};

export default TierStar;
