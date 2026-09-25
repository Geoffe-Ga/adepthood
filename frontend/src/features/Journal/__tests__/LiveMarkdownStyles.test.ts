import { describe, expect, it } from '@jest/globals';
import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import entryStyles from '../JournalEntry.styles';
import liveStyles from '../LiveMarkdownStyles';

import { colors } from '@/design/tokens';

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

/** WCAG 1.4.3: the characters the writer typed and is editing are text. */
const TEXT_CONTRAST = 4.5;

const GROUNDS = { paper: colors.paper.background, quote: colors.paper.backgroundAlt };

describe('live mirror text contrast', () => {
  it.each(['mirrorText', 'dimmed', 'revealed', 'italic'] as const)(
    'draws %s at 4.5:1 or better on the page and on a quote line, fully opaque',
    (name) => {
      const style: TextStyle = StyleSheet.flatten<TextStyle>(liveStyles[name]);
      expect(style.opacity ?? 1).toBe(1);
      for (const ground of Object.values(GROUNDS)) {
        expect(contrast(String(style.color), ground)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      }
    },
  );

  it('tells a dimmed delimiter from a revealed one, and italic from plain content', () => {
    const color = (name: 'dimmed' | 'revealed' | 'italic' | 'mirrorText') =>
      StyleSheet.flatten<TextStyle>(liveStyles[name]).color;
    expect(color('dimmed')).not.toBe(color('revealed'));
    // Revealed delimiters come up to the content's full ink.
    expect(color('revealed')).toBe(color('mirrorText'));
    expect(color('italic')).not.toBe(color('mirrorText'));
  });
});

/**
 * The properties that decide where a glyph lands. The mirror and the field must
 * agree on every one of them, or the mirror's glyphs drift out from under the
 * textarea's caret.
 */
const FONT_METRICS = [
  'fontFamily',
  'fontSize',
  'lineHeight',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
] as const;

/** The only properties a mirror run may set: none of them moves a glyph. */
const ADVANCE_NEUTRAL = new Set([
  'color',
  'backgroundColor',
  'textShadowColor',
  'textShadowOffset',
  'textShadowRadius',
  'textDecorationLine',
  'textDecorationColor',
]);

const BOX_PROPERTY = /^(?:padding|margin|border)/u;

describe('live mirror metrics match the field by construction', () => {
  const field = StyleSheet.flatten<TextStyle>([entryStyles.bodyInput, liveStyles.inputMirrored]);
  const mirrorText = StyleSheet.flatten<TextStyle>(liveStyles.mirrorText);

  it.each(FONT_METRICS)('gives the mirror text the field’s own %s', (property) => {
    expect(field[property]).toBeDefined();
    expect(mirrorText[property]).toBe(field[property]);
  });

  it.each(['dimmed', 'revealed', 'bold', 'italic', 'underline', 'quoteLine'] as const)(
    'styles %s runs only with advance-neutral properties',
    (name) => {
      const keys = Object.keys(StyleSheet.flatten<TextStyle>(liveStyles[name]));
      expect(keys.filter((key) => !ADVANCE_NEUTRAL.has(key))).toEqual([]);
    },
  );

  it('keeps box spacing off the mirror’s INLINE text, where the browser would ignore it', () => {
    // react-native-web renders a top-level Text as display:inline, so vertical
    // padding on it moves no line: it has to sit on the block container.
    expect(Object.keys(mirrorText).filter((key) => BOX_PROPERTY.test(key))).toEqual([]);
  });

  it('insets the mirror’s block container by exactly the field’s padding', () => {
    const mirror = StyleSheet.flatten<ViewStyle>(liveStyles.mirror);
    for (const side of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const) {
      expect(mirror[side] ?? 0).toBe(field[side] ?? 0);
    }
    expect(field.paddingTop).toBeGreaterThan(0);
  });

  it('never lets the field reserve a scrollbar gutter the mirror lacks', () => {
    expect(field.overflow).toBe('hidden');
  });
});
