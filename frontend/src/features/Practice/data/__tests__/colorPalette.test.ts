/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  COLOR_PALETTE,
  SPIRAL_DYNAMICS_COLORS,
  contrastRatio,
  isSpiralDynamicsColor,
  relativeLuminance,
  swatchFor,
} from '../colorPalette';

const WCAG_AA_BODY = 4.5;

describe('relativeLuminance', () => {
  it('returns 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('matches the WCAG reference for mid-grey #777777', () => {
    // #777 has a published relative luminance of ~0.1845.
    expect(relativeLuminance('#777777')).toBeCloseTo(0.1845, 3);
  });

  it('accepts uppercase hex and the leading "#" is optional', () => {
    expect(relativeLuminance('FFFFFF')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('throws on a malformed hex string instead of returning NaN', () => {
    expect(() => relativeLuminance('not-a-color')).toThrow(/hex/i);
    expect(() => relativeLuminance('#12345')).toThrow(/hex/i);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('is symmetric — order of arguments does not change the ratio', () => {
    const a = contrastRatio('#1a1a1a', '#d8cbb8');
    const b = contrastRatio('#d8cbb8', '#1a1a1a');
    expect(a).toBeCloseTo(b, 5);
  });
});

describe('COLOR_PALETTE', () => {
  it('maps every spiral-dynamics colour exactly once', () => {
    const keys = Object.keys(COLOR_PALETTE);
    expect(keys).toHaveLength(SPIRAL_DYNAMICS_COLORS.length);
    for (const colour of SPIRAL_DYNAMICS_COLORS) {
      expect(COLOR_PALETTE[colour]).toBeDefined();
    }
  });

  it('contains all ten brand frequencies', () => {
    expect(SPIRAL_DYNAMICS_COLORS).toEqual([
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
    ]);
  });

  it.each(SPIRAL_DYNAMICS_COLORS)(
    '%s swatch hits WCAG AA body-text contrast (>= 4.5:1)',
    (colour) => {
      const swatch = COLOR_PALETTE[colour];
      const ratio = contrastRatio(swatch.text, swatch.bg);
      // Fail message helps designers tweak palette safely.
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_BODY);
    },
  );
});

describe('isSpiralDynamicsColor', () => {
  it('accepts every catalogued colour', () => {
    for (const colour of SPIRAL_DYNAMICS_COLORS) {
      expect(isSpiralDynamicsColor(colour)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isSpiralDynamicsColor('Magenta')).toBe(false);
    expect(isSpiralDynamicsColor('')).toBe(false);
  });
});

describe('swatchFor', () => {
  it('returns the catalogued swatch for a known colour', () => {
    expect(swatchFor('Orange')).toBe(COLOR_PALETTE.Orange);
  });

  it('falls back to the neutral "Clear Light" swatch for unknown values', () => {
    // Defensive: backend could send a colour the frontend palette has
    // not yet learnt about; the banner must still render something
    // legible rather than crash.
    expect(swatchFor('Magenta')).toBe(COLOR_PALETTE['Clear Light']);
  });
});
