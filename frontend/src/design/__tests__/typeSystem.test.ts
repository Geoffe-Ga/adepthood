/* eslint-env jest */
/* global describe, it, expect */
import { breakpoints, editorialType, fonts, type } from '../tokens';

describe('app type system (Candle & Ink, #800)', () => {
  describe('fonts', () => {
    it('exposes non-empty serif + sans system stacks', () => {
      expect(typeof fonts.serif).toBe('string');
      expect(fonts.serif.length).toBeGreaterThan(0);
      expect(typeof fonts.sans).toBe('string');
      expect(fonts.sans.length).toBeGreaterThan(0);
    });

    it('shares its serif with the journal editorialType (single source)', () => {
      expect(editorialType.serif).toBe(fonts.serif);
    });
  });

  describe('type(width) ramp', () => {
    const ramp = type(breakpoints.md);

    it('exports the full ramp', () => {
      expect(Object.keys(ramp)).toEqual([
        'display',
        'title',
        'heading',
        'body',
        'label',
        'caption',
      ]);
    });

    it('uses serif for display/heading and clean sans for body/labels', () => {
      for (const key of ['display', 'title', 'heading'] as const) {
        expect(ramp[key].fontFamily).toBe(fonts.serif);
      }
      for (const key of ['body', 'label', 'caption'] as const) {
        expect(ramp[key].fontFamily).toBe(fonts.sans);
      }
    });

    it('descends in size and keeps lineHeight above fontSize', () => {
      const order = ['display', 'title', 'heading', 'body', 'label', 'caption'] as const;
      for (let i = 1; i < order.length; i += 1) {
        expect(ramp[order[i]!].fontSize).toBeLessThan(ramp[order[i - 1]!].fontSize);
      }
      for (const key of order) {
        expect(ramp[key].lineHeight).toBeGreaterThan(ramp[key].fontSize);
      }
    });

    it('is responsive — a tablet reads larger than a phone', () => {
      expect(type(breakpoints.xl).body.fontSize).toBeGreaterThan(type(0).body.fontSize);
    });
  });
});
