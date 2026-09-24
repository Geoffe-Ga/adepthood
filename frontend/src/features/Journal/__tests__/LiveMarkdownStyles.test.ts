import { describe, expect, it } from '@jest/globals';
import { StyleSheet, type TextStyle } from 'react-native';

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
