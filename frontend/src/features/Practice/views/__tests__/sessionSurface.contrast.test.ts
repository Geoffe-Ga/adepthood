/* eslint-env jest */
/* global describe, it, expect */
import { CALM_SURFACE, UMBER_SURFACE } from '../sessionSurface';

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

describe('UMBER_SURFACE (#1905 dark player)', () => {
  const inks = ['text', 'textSoft', 'textMuted', 'accent'] as const;

  it.each(inks)('%s clears WCAG AA on the umber ground', (key) => {
    expect(contrast(UMBER_SURFACE[key], UMBER_SURFACE.ground)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(inks)('%s clears WCAG AA on the raised step', (key) => {
    expect(contrast(UMBER_SURFACE[key], UMBER_SURFACE.raised)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('raised is a lifted step above the ground', () => {
    expect(luminance(UMBER_SURFACE.raised)).toBeGreaterThan(luminance(UMBER_SURFACE.ground));
  });
});

describe('CALM_SURFACE (still used by the Return metta session)', () => {
  const inks = ['text', 'textSoft', 'textMuted', 'accent'] as const;

  it.each(inks)('%s clears WCAG AA on the calm lifted-paper ground', (key) => {
    expect(contrast(CALM_SURFACE[key], CALM_SURFACE.ground)).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
