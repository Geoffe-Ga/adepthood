/* eslint-env jest */
/* global describe, it, expect */
import { StyleSheet } from 'react-native';

import { accent, colors, ink, surface, surfaceShadow } from '../tokens';

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

describe('semantic tokens (Candle & Ink)', () => {
  describe('surface', () => {
    it('derives its grounds from the warm paper palette', () => {
      expect(surface.canvas).toBe(colors.paper.background);
      expect(surface.sunken).toBe(colors.paper.backgroundAlt);
      expect(surface.desk).toBe(colors.paper.desk);
      expect(surface.hairline).toBe(colors.paper.hairline);
      expect(surface.raised).toMatch(/^#[\da-f]{6}$/i);
    });

    it('floats raised above canvas above the desk', () => {
      expect(luminance(surface.raised)).toBeGreaterThan(luminance(surface.canvas));
      expect(luminance(surface.desk)).toBeLessThan(luminance(surface.canvas));
    });
  });

  describe('ink + accent contrast', () => {
    it('every ink value clears WCAG AA on the canvas', () => {
      for (const value of Object.values(ink)) {
        expect(contrast(value, surface.canvas)).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });

    it('every accent value clears WCAG AA on the canvas', () => {
      for (const value of Object.values(accent)) {
        expect(contrast(value, surface.canvas)).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });

    it('keeps an original terracotta accent (not the graphical-only tier swatch)', () => {
      // The accent is derived from — but distinct from — the 3:1 graphical
      // tier.clear swatch, darkened so it clears AA as text.
      expect(accent.primary).not.toBe(colors.tier.clear);
      expect(luminance(accent.primary)).toBeLessThan(luminance(colors.tier.clear));
    });
  });

  describe('surfaceShadow', () => {
    it('flattens to warm, ink-tinted lifts with iOS/web + Android props', () => {
      for (const lift of [surfaceShadow.card, surfaceShadow.raised]) {
        const flat = StyleSheet.flatten(lift);
        expect(flat.shadowColor).toBe(colors.paper.ink);
        expect(flat.shadowOffset?.height).toBeGreaterThan(0);
        expect(flat.shadowOpacity).toBeGreaterThan(0);
        expect(flat.shadowRadius).toBeGreaterThan(0);
        expect(flat.elevation).toBeGreaterThan(0);
      }
      // A raised sheet sits higher off the desk than a card.
      expect(surfaceShadow.raised.elevation).toBeGreaterThan(surfaceShadow.card.elevation);
    });
  });
});
