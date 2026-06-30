/* eslint-env jest */
/* global describe, it, expect */
import { StyleSheet } from 'react-native';

import { accent, onShowcase, showcase, showcaseShadow, surface } from '../tokens';

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
const channels = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
};

describe('showcase tokens (#826)', () => {
  it('is a warm umber — not navy, not Material #121212', () => {
    const [r, , b] = channels(showcase.canvas);
    expect(r).toBeGreaterThanOrEqual(b); // warm: red channel >= blue (not navy)
    expect(showcase.canvas).not.toBe('#121212');
    // raised is a lifted step above the canvas
    expect(luminance(showcase.raised)).toBeGreaterThan(luminance(showcase.canvas));
  });

  it('every onShowcase ink value clears WCAG AA on the umber ground', () => {
    for (const value of Object.values(onShowcase)) {
      expect(contrast(value, showcase.canvas)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('the CalloutBand cream CTA clears AA on the accent ground', () => {
    expect(contrast(surface.canvas, accent.primary)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('showcaseShadow flattens to portable shadow* + Android elevation', () => {
    const flat = StyleSheet.flatten(showcaseShadow);
    expect(flat.shadowOffset?.height).toBeGreaterThan(0);
    expect(flat.shadowOpacity).toBeGreaterThan(0);
    expect(flat.shadowRadius).toBeGreaterThan(0);
    expect(flat.elevation).toBeGreaterThan(0);
  });
});
