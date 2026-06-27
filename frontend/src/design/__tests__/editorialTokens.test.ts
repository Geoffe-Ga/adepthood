/* eslint-env jest */
/* global describe, it, expect */
import { colors, editorialType, journalLayout } from '../tokens';

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

describe('editorial tokens', () => {
  describe('colors.paper', () => {
    it('exports the paper palette keys', () => {
      expect(Object.keys(colors.paper)).toEqual(
        expect.arrayContaining([
          'background',
          'backgroundAlt',
          'ink',
          'inkSoft',
          'hairline',
          'anchorHighlight',
        ]),
      );
    });

    it('meets WCAG AA for ink and inkSoft on the paper ground', () => {
      expect(contrast(colors.paper.ink, colors.paper.background)).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(contrast(colors.paper.inkSoft, colors.paper.background)).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    });
  });

  describe('colors.marginalia', () => {
    it('exports an accent per note kind', () => {
      expect(Object.keys(colors.marginalia)).toEqual(['theme', 'connection', 'symbol']);
    });

    it('every kind accent meets AA on the paper ground', () => {
      for (const accent of Object.values(colors.marginalia)) {
        expect(contrast(accent, colors.paper.background)).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });
  });

  describe('journalLayout', () => {
    it('exports the page metrics as positive numbers', () => {
      expect(Object.keys(journalLayout)).toEqual([
        'marginColumnWidth',
        'pageHorizontalPadding',
        'pageMaxWidth',
        'marginNoteGap',
      ]);
      for (const value of Object.values(journalLayout)) {
        expect(value).toBeGreaterThan(0);
      }
    });
  });

  describe('editorialType', () => {
    it('resolves a non-empty serif stack', () => {
      expect(typeof editorialType.serif).toBe('string');
      expect(editorialType.serif.length).toBeGreaterThan(0);
    });

    it('exports the long-form scale + a margin-note style', () => {
      for (const key of ['display', 'title', 'body', 'note', 'caption', 'marginNote'] as const) {
        const style = editorialType[key];
        expect(style.fontFamily).toBe(editorialType.serif);
        expect(style.fontSize).toBeGreaterThan(0);
        expect(style.lineHeight).toBeGreaterThan(style.fontSize);
      }
    });

    it('uses a body size in the editorial 17-18px range', () => {
      expect(editorialType.body.fontSize).toBeGreaterThanOrEqual(17);
      expect(editorialType.body.fontSize).toBeLessThanOrEqual(18);
    });
  });
});
