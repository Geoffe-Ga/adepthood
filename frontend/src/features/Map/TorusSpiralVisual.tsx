// frontend/features/Map/TorusSpiralVisual.tsx

import React from 'react';
import Svg, { Path } from 'react-native-svg';

import { accent, ink } from '../../design/tokens';

import styles from './Map.styles';
import { spiralPath, torusRings } from './torusGeometry';

/**
 * Static torus/spiral illustration for the "How the Wavelength works" explainer.
 *
 * It draws the model warmly rather than measuring anything: a stack of nested,
 * tilted ellipse rings for the torus (the auric field) with the growing spiral
 * winding up through them. The art is intentionally still — no animation — so it
 * respects "Reduce Motion" by construction and adds nothing to the Map screen's
 * render budget (it mounts only while the explainer sheet is open).
 *
 * It carries an ``image`` role and a describing label because it depicts the
 * model, and is ``pointerEvents="none"`` so it never intercepts the sheet's
 * scroll.
 */

/** Logical drawing width the geometry is computed against (the SVG viewBox). */
const VIEW_WIDTH = 320;

/** Logical drawing height the geometry is computed against (the SVG viewBox). */
const VIEW_HEIGHT = 200;

/** Rendered height of the illustration, in dp; the width fills its container. */
const RENDER_HEIGHT = 160;

/** Stroke thickness of each faint torus ring, in logical units. */
const RING_STROKE_WIDTH = 1.5;

/** Softening opacity of the torus rings so the spiral reads as the foreground. */
const RING_OPACITY = 0.5;

/** Stroke thickness of the foreground spiral, in logical units. */
const SPIRAL_STROKE_WIDTH = 2.5;

/** Screen-reader description of the illustration's meaning. */
const ACCESSIBILITY_LABEL =
  'An illustration of the torus: a spiral rising and widening through the octaves.';

// Geometry is static, so it is computed once at module load rather than per render.
const RINGS = torusRings(VIEW_WIDTH, VIEW_HEIGHT);
const SPIRAL = spiralPath(VIEW_WIDTH, VIEW_HEIGHT);

/** The explainer's decorative-but-labeled torus/spiral artwork. */
export default function TorusSpiralVisual(): React.JSX.Element {
  return (
    <Svg
      testID="torus-spiral-visual"
      width="100%"
      height={RENDER_HEIGHT}
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      style={styles.explainerVisual}
      pointerEvents="none"
      accessibilityRole="image"
      accessibilityLabel={ACCESSIBILITY_LABEL}
    >
      {RINGS.map((ring) => (
        <Path
          key={ring.d}
          d={ring.d}
          stroke={ink.soft}
          strokeOpacity={RING_OPACITY}
          strokeWidth={RING_STROKE_WIDTH}
          fill="none"
        />
      ))}
      <Path
        d={SPIRAL}
        stroke={accent.primary}
        strokeWidth={SPIRAL_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}
