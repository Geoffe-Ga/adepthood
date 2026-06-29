/**
 * Spiral-Dynamics colour palette for the Practice frequency banner.
 *
 * Every swatch is a `(bg, text)` pair tuned so body copy clears WCAG 2.1 AA
 * (≥ 4.5:1 contrast). The contrast invariant is enforced by
 * `__tests__/colorPalette.test.ts`, which recomputes the ratio for each
 * entry — so designers tweaking a hue here will see the brand stay
 * honest the moment they break the rule.
 */

export const SPIRAL_DYNAMICS_COLORS = [
  'Beige',
  'Purple',
  'Red',
  'Blue',
  'Orange',
  'Green',
  'Yellow',
  'Turquoise',
  'Ultraviolet',
  'Clear Light',
] as const;

export type SpiralDynamicsColor = (typeof SPIRAL_DYNAMICS_COLORS)[number];

export interface ColorSwatch {
  /** Background fill — the frequency colour itself. */
  bg: string;
  /** Body-text colour chosen so contrast on `bg` clears WCAG-AA. */
  text: string;
}

export const COLOR_PALETTE: Readonly<Record<SpiralDynamicsColor, ColorSwatch>> = Object.freeze({
  Beige: { bg: '#d8cbb8', text: '#000000' },
  Purple: { bg: '#a093c6', text: '#000000' },
  Red: { bg: '#cc5b5b', text: '#000000' },
  Blue: { bg: '#6fa3d3', text: '#000000' },
  Orange: { bg: '#f29f67', text: '#000000' },
  Green: { bg: '#6fcf97', text: '#000000' },
  Yellow: { bg: '#f2e96d', text: '#000000' },
  Turquoise: { bg: '#50c9c3', text: '#000000' },
  Ultraviolet: { bg: '#8e44ad', text: '#ffffff' },
  'Clear Light': { bg: '#ffffff', text: '#000000' },
});

export function isSpiralDynamicsColor(value: string): value is SpiralDynamicsColor {
  return (SPIRAL_DYNAMICS_COLORS as readonly string[]).includes(value);
}

/**
 * Look up the swatch for a server-supplied colour string. Falls back to the
 * neutral "Clear Light" swatch if the server sends a label the frontend
 * palette hasn't catalogued yet — the banner stays legible instead of
 * crashing on a typo from a future content drop.
 */
export function swatchFor(color: string): ColorSwatch {
  return isSpiralDynamicsColor(color) ? COLOR_PALETTE[color] : COLOR_PALETTE['Clear Light'];
}
