/* eslint-env jest */
/* global describe, it, expect */
import {
  INTERACTIVE_TEXT_MIN,
  colors,
  editorialType,
  journalLayout,
  journalSheet,
  paperShadow,
  uiType,
} from '../tokens';

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
          'desk',
          'sheetEdge',
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

    it('has a desk ground darker than the page (so the sheet reads as lifted)', () => {
      expect(colors.paper.desk).toMatch(/^#[\da-f]{6}$/i);
      expect(colors.paper.sheetEdge).toMatch(/^#[\da-f]{6}$/i);
      expect(luminance(colors.paper.desk)).toBeLessThan(luminance(colors.paper.background));
    });

    // RED (promote-a-quote): `quoteHighlight` does not exist on `colors.paper`
    // yet -- this fails with a TypeError reading `.quoteHighlight` of
    // undefined until the implementation-specialist adds the token.
    it('exports a quoteHighlight wash distinct from the note anchorHighlight, meeting AA ink contrast', () => {
      expect(colors.paper.quoteHighlight).toMatch(/^#[\da-f]{6}$/i);
      expect(colors.paper.quoteHighlight).not.toBe(colors.paper.anchorHighlight);
      expect(contrast(colors.paper.ink, colors.paper.quoteHighlight)).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    });
  });

  describe('paperShadow', () => {
    it('exports sheet + card lifts with shadow props and an Android elevation', () => {
      for (const lift of [paperShadow.sheet, paperShadow.card]) {
        expect(lift.shadowColor).toBe(colors.paper.ink);
        expect(lift.shadowOffset.height).toBeGreaterThan(0);
        expect(lift.shadowOpacity).toBeGreaterThan(0);
        expect(lift.elevation).toBeGreaterThan(0);
      }
      // The sheet sits higher off the desk than a card.
      expect(paperShadow.sheet.elevation).toBeGreaterThan(paperShadow.card.elevation);
    });
  });

  describe('journalSheet', () => {
    it('exports positive sheet metrics without touching journalLayout', () => {
      for (const value of Object.values(journalSheet)) {
        expect(value).toBeGreaterThan(0);
      }
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
      for (const key of [
        'display',
        'title',
        'heading',
        'body',
        'note',
        'caption',
        'marginNote',
        'action',
      ] as const) {
        const style = editorialType[key];
        expect(style.fontFamily).toBe(editorialType.serif);
        expect(style.fontSize).toBeGreaterThan(0);
        expect(style.lineHeight).toBeGreaterThan(style.fontSize);
      }
    });

    it('slots heading strictly between body and title in size and line height', () => {
      const { heading } = editorialType;
      expect(heading.fontSize).toBeGreaterThan(editorialType.body.fontSize);
      expect(heading.fontSize).toBeLessThan(editorialType.title.fontSize);
      expect(heading.lineHeight).toBeGreaterThan(editorialType.body.lineHeight);
      expect(heading.lineHeight).toBeLessThan(editorialType.title.lineHeight);
    });

    it('uses a body size in the editorial 17-18px range', () => {
      expect(editorialType.body.fontSize).toBeGreaterThanOrEqual(17);
      expect(editorialType.body.fontSize).toBeLessThanOrEqual(18);
    });

    it('defines an accessibility floor for tappable text, exactly 16px', () => {
      // caption is 13px, below the tappable-text floor -- interactive labels
      // must use editorialType.action (16px) instead. This constant is an
      // exact accessibility floor, never a >= comparison.
      expect(INTERACTIVE_TEXT_MIN).toBe(16);
    });

    it('sizes action to the interactive floor, matching the ui button face', () => {
      expect(editorialType.action.fontSize).toBe(INTERACTIVE_TEXT_MIN);
      expect(editorialType.action.fontSize).toBe(uiType.button.fontSize);
      expect(editorialType.action.lineHeight).toBe(24);
      expect(editorialType.action.fontWeight).toBe('600');
      expect(editorialType.action.fontFamily).toBe(editorialType.serif);
    });
  });
});
