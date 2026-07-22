/* eslint-env jest */
/* global describe, it, expect */
import { CALM_SURFACE, LIGHT_SURFACE, UMBER_SURFACE } from '../sessionSurface';

import { colors } from '@/design/tokens';

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

describe('surface danger ink', () => {
  const dangerGrounds = ['ground', 'raised'] as const;

  it.each(dangerGrounds)('the umber danger ink clears WCAG AA on the %s', (key) => {
    expect(contrast(UMBER_SURFACE.danger, UMBER_SURFACE[key])).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('keeps the light surface danger byte-for-byte on the shared danger token', () => {
    expect(LIGHT_SURFACE.danger).toBe(colors.danger);
  });

  it('keeps the calm surface danger byte-for-byte on the shared danger token', () => {
    expect(CALM_SURFACE.danger).toBe(colors.danger);
  });
});

describe('white labels on the session control fills', () => {
  const fills: [string, string][] = [
    ['primary', colors.primary],
    ['success', colors.success],
    ['warning', colors.warning],
  ];

  it.each(fills)('the light label clears WCAG AA on the %s fill', (_name, fill) => {
    expect(contrast(colors.text.light, fill)).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('save-error danger ink on the umber ground', () => {
  it('clears WCAG AA for the destructive border ink', () => {
    const ratio = contrast(colors.destructive.border, UMBER_SURFACE.ground);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
