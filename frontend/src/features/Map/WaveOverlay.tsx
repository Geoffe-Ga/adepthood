// frontend/features/Map/WaveOverlay.tsx

import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Path, Polygon } from 'react-native-svg';

import { waveArrowheads, waveSegments } from './waveGeometry';
import type { StageAnchors } from './waveGeometry';

/**
 * Continuous sine-wave artwork for the Map's center column, rendered behind the
 * per-stage tap cells. The wave rises upward like a struck tuning fork, wobbling
 * left for even stages and right for odd ones and tapering toward center at the
 * top. Each segment and arrowhead carries its stage's textColor.
 *
 * The overlay is purely decorative: it is non-interactive and hidden from the
 * accessibility tree so the stage hotspots remain the sole tap/read targets.
 */

/** Stroke thickness of each wave segment, in pixels. */
const WAVE_STROKE_WIDTH = 3;

/** Stroke styling shared by every wave path. */
const WAVE_STROKE_PROPS = {
  fill: 'none',
  strokeWidth: WAVE_STROKE_WIDTH,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** Smallest positive layout extent worth drawing; below it there is no wave. */
const MIN_DRAWABLE_EXTENT = 1;

interface WaveOverlayProps {
  /** Measured width of the grid the wave fills, in pixels. */
  width: number;
  /** Measured height of the grid the wave fills, in pixels. */
  height: number;
  /** Measured per-stage vertical centers; missing stages use nominal bands. */
  anchors?: StageAnchors;
  /**
   * Prefix for every testID this overlay emits. The magnifier lens renders a
   * second, magnified copy of the wave; the prefix keeps the two copies'
   * testIDs distinct so each remains uniquely findable.
   */
  idPrefix?: string;
}

/** SVG sine-wave overlay sized to the measured grid; null until measured. */
export const WaveOverlay = ({
  width,
  height,
  anchors = {},
  idPrefix = '',
}: WaveOverlayProps): React.JSX.Element | null => {
  const smallerExtent = Math.min(width, height);
  if (smallerExtent < MIN_DRAWABLE_EXTENT) return null;
  const segments = waveSegments(width, height, anchors);
  const arrowheads = waveArrowheads(width, height, anchors);
  return (
    <Svg
      testID={`${idPrefix}map-wave`}
      width={width}
      height={height}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      accessible={false}
    >
      {segments.map((segment) => (
        <Path
          key={`near-${segment.stageNumber}-${segment.half}`}
          testID={`${idPrefix}near-${segment.stageNumber}-${segment.half}`}
          d={segment.d}
          stroke={segment.color}
          {...WAVE_STROKE_PROPS}
        />
      ))}
      {arrowheads.map((arrowhead) => (
        <Polygon
          key={arrowhead.stageNumber}
          testID={`${idPrefix}wave-arrow-${arrowhead.stageNumber}`}
          points={arrowhead.points}
          fill={arrowhead.color}
        />
      ))}
    </Svg>
  );
};

export default WaveOverlay;
