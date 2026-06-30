/* eslint-env jest */
/* global describe, it, expect */
import { accentDark, inkDark, surfaceDark } from '../tokens';

/** WCAG relative luminance of a #rrggbb color. */
const luminance = (hex: string): number => {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a 6-digit hex: ${hex}`);
  const channels = [match[1], match[2], match[3]].map((pair) => {
    const c = Number.parseInt(pair!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

const contrast = (a: string, b: string): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

const AA_NORMAL = 4.5;

describe('warm dark tokens (Candle & Ink, #804)', () => {
  it('uses a warm umber ground, not neutral #121212', () => {
    expect(surfaceDark.canvas).not.toBe('#121212');
    // Warm = red channel >= blue channel on the ground.
    const hex = surfaceDark.canvas.replace('#', '');
    expect(Number.parseInt(hex.slice(0, 2), 16)).toBeGreaterThanOrEqual(
      Number.parseInt(hex.slice(4, 6), 16),
    );
  });

  it('floats raised above canvas above the desk', () => {
    expect(luminance(surfaceDark.raised)).toBeGreaterThan(luminance(surfaceDark.canvas));
    expect(luminance(surfaceDark.desk)).toBeLessThan(luminance(surfaceDark.canvas));
  });

  it('every inkDark value clears WCAG AA on the dark canvas', () => {
    for (const value of Object.values(inkDark)) {
      expect(contrast(value, surfaceDark.canvas)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('every accentDark value clears WCAG AA on the dark canvas', () => {
    for (const value of Object.values(accentDark)) {
      expect(contrast(value, surfaceDark.canvas)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });
});
