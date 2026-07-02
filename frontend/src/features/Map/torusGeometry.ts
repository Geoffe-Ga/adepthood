// frontend/features/Map/torusGeometry.ts

/**
 * Pure geometry for the Wavelength explainer's torus/spiral illustration.
 *
 * The picture holds two motifs from the model: the torus (the auric field) as a
 * stack of nested, tilted ellipse rings, and the growing spiral that widens and
 * lifts through it. Every helper works in unit space [0,1] and scales that unit
 * space into pixel space; none of them touch React, so the illustration's math
 * is testable in isolation from rendering.
 */

/** Decimal places kept in emitted SVG coordinates (matches waveGeometry/TierStar). */
const COORD_PRECISION = 3;

/** Number of nested ellipse rings that suggest the torus / auric field. */
export const TORUS_RING_COUNT = 4;

/** Number of points sampled along the rising spiral path. */
export const SPIRAL_SAMPLE_COUNT = 48;

/** Horizontal centre of the illustration in unit space; every ring shares it. */
const CENTER_X = 0.5;

/** Vertical centre of the torus body in unit space. */
const CENTER_Y = 0.5;

/** Widest ring's horizontal radius in unit space (leaves a margin inside the box). */
const TORUS_OUTER_RX = 0.42;

/** Widest ring's vertical radius — flatter than rx so the torus reads as tilted. */
const TORUS_OUTER_RY = 0.2;

/** Fraction each inner ring shrinks relative to the widest ring's radii. */
const RING_STEP = 0.18;

/** Number of full turns the spiral winds as it climbs. */
const SPIRAL_TURNS = 2.5;

/** Spiral's maximum horizontal swing from centre, reached at the top of the climb. */
const SPIRAL_MAX_RX = 0.4;

/** Spiral's gentle vertical wobble, giving the climb a tilted, three-dimensional read. */
const SPIRAL_MAX_RY = 0.06;

/** Vertical position of the spiral's first (lowest) sample in unit space. */
const SPIRAL_BOTTOM_Y = 0.92;

/** Vertical position of the spiral's last (highest) sample in unit space. */
const SPIRAL_TOP_Y = 0.08;

/** A full revolution in radians; the spiral angle is a multiple of it. */
const FULL_TURN = Math.PI * 2;

/** Round a unit coordinate into a pixel coordinate string at fixed precision. */
const toPixel = (unit: number, extent: number): string => (unit * extent).toFixed(COORD_PRECISION);

/** A single nested ellipse ring of the torus, as an SVG path string. */
export interface TorusRing {
  /** SVG path data drawing one tilted ellipse in pixel space. */
  d: string;
}

/**
 * The horizontal and vertical radii, in unit space, of ring ``index`` (0 is the
 * widest, outermost ring). Each successive ring shrinks by ``RING_STEP`` so the
 * stack reads as a field of concentric halos around a common centre.
 */
const ringRadii = (index: number): { rx: number; ry: number } => {
  const scale = 1 - RING_STEP * index;
  return { rx: TORUS_OUTER_RX * scale, ry: TORUS_OUTER_RY * scale };
};

/**
 * One tilted ellipse centred on the illustration, drawn with two SVG arc
 * commands (left edge over the top to the right edge, then back under). All
 * emitted coordinates stay within the given width/height because the widest
 * radius keeps a margin inside unit space.
 */
const ellipsePath = (rx: number, ry: number, width: number, height: number): string => {
  const left = toPixel(CENTER_X - rx, width);
  const right = toPixel(CENTER_X + rx, width);
  const midY = toPixel(CENTER_Y, height);
  const rxPixel = toPixel(rx, width);
  const ryPixel = toPixel(ry, height);
  return `M ${left} ${midY} A ${rxPixel} ${ryPixel} 0 1 0 ${right} ${midY} A ${rxPixel} ${ryPixel} 0 1 0 ${left} ${midY}`;
};

/**
 * The torus as ``TORUS_RING_COUNT`` nested tilted ellipses in pixel space,
 * widest first. Coordinates scale with width and height, so a larger layout
 * yields a larger torus.
 */
export const torusRings = (width: number, height: number): readonly TorusRing[] =>
  Array.from({ length: TORUS_RING_COUNT }, (_unused, index) => {
    const { rx, ry } = ringRadii(index);
    return { d: ellipsePath(rx, ry, width, height) };
  });

/**
 * The (x, y) unit-space position of the spiral at sample ``index`` of
 * ``SPIRAL_SAMPLE_COUNT``. The climb runs from ``SPIRAL_BOTTOM_Y`` up to
 * ``SPIRAL_TOP_Y`` (y decreases as the spiral rises), the horizontal swing
 * grows from centre toward ``SPIRAL_MAX_RX`` as it lifts (the spiral widening
 * the torus), and a small vertical wobble gives the turns a tilted read.
 */
const spiralPoint = (index: number): { x: number; y: number } => {
  const t = index / (SPIRAL_SAMPLE_COUNT - 1);
  const angle = t * SPIRAL_TURNS * FULL_TURN;
  const baseY = SPIRAL_BOTTOM_Y + (SPIRAL_TOP_Y - SPIRAL_BOTTOM_Y) * t;
  const x = CENTER_X + SPIRAL_MAX_RX * t * Math.cos(angle);
  const y = baseY + SPIRAL_MAX_RY * t * Math.sin(angle);
  return { x, y };
};

/**
 * The rising spiral as one SVG polyline path in pixel space, sampled at
 * ``SPIRAL_SAMPLE_COUNT`` points from the bottom of the box to the top.
 * Coordinates scale with width and height.
 */
export const spiralPath = (width: number, height: number): string => {
  const commands = Array.from({ length: SPIRAL_SAMPLE_COUNT }, (_unused, index) => {
    const { x, y } = spiralPoint(index);
    const verb = index === 0 ? 'M' : 'L';
    return `${verb} ${toPixel(x, width)} ${toPixel(y, height)}`;
  });
  return commands.join(' ');
};
