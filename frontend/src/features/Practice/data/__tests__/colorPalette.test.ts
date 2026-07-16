/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  COLOR_PALETTE,
  SPIRAL_DYNAMICS_COLORS,
  isSpiralDynamicsColor,
  swatchFor,
} from '../colorPalette';

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
      'Teal',
      'Ultraviolet',
      'Clear Light',
    ]);
  });

  it('does not list the legacy Spiral-Dynamics name as canonical', () => {
    expect(SPIRAL_DYNAMICS_COLORS).not.toContain('Turquoise');
  });
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

  it('resolves the legacy "Turquoise" label to the Teal swatch', () => {
    // A server still on the pre-rename dataset can send "Turquoise" for
    // stage 8; it must render the Teal swatch, not the white fallback.
    expect(swatchFor('Turquoise')).toBe(COLOR_PALETTE.Teal);
  });

  it('falls back to the neutral "Clear Light" swatch for unknown values', () => {
    // Defensive: backend could send a colour the frontend palette has
    // not yet learnt about; the banner must still render something
    // legible rather than crash.
    expect(swatchFor('Magenta')).toBe(COLOR_PALETTE['Clear Light']);
  });
});
