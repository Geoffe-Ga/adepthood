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

const HEX_PATTERN = /^#?[0-9a-f]{6}$/i;

function parseChannel(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
}

function srgbToLinear(channel: number): number {
  // sRGB → linear-light per WCAG 2.1 §1.4.3 definition of relative luminance.
  return channel <= 0.039_28 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * Relative luminance of an sRGB hex colour per WCAG 2.1.
 *
 * Throws on malformed input so a typo in the palette surfaces as a loud
 * test failure rather than a silent `NaN` contrast ratio.
 */
export function relativeLuminance(hex: string): number {
  if (!HEX_PATTERN.test(hex)) {
    throw new Error(`Expected 6-digit hex colour, got ${JSON.stringify(hex)}`);
  }
  const raw = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = srgbToLinear(parseChannel(raw, 0));
  const g = srgbToLinear(parseChannel(raw, 2));
  const b = srgbToLinear(parseChannel(raw, 4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two sRGB hex colours. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

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
