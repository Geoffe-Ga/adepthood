/* eslint-env jest */
/* global describe, it, expect */
import { accent, ink, surface } from '../../design/tokens';
import { navTheme } from '../theme';

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

describe('navTheme (#803)', () => {
  it('derives its chrome colors from the warm semantic tokens', () => {
    expect(navTheme.colors.primary).toBe(accent.primary);
    expect(navTheme.colors.background).toBe(surface.canvas);
    expect(navTheme.colors.card).toBe(surface.raised);
    expect(navTheme.colors.text).toBe(ink.primary);
    expect(navTheme.colors.border).toBe(surface.hairline);
  });

  it('keeps a fonts block (v7 Theme contract inherited from DefaultTheme)', () => {
    expect(navTheme.fonts).toBeDefined();
  });

  it('active + inactive tab tints clear AA on the raised tab-bar ground', () => {
    // active = accent.primary, inactive = ink.muted, ground = surface.raised
    expect(contrast(accent.primary, surface.raised)).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrast(ink.muted, surface.raised)).toBeGreaterThanOrEqual(AA_NORMAL);
    // active vs inactive are distinguished by hue (terracotta vs muted ink), not
    // luminance, so they must not be the same value.
    expect(accent.primary).not.toBe(ink.muted);
  });
});
