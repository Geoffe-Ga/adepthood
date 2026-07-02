/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';
import { StyleSheet } from 'react-native';

import { accent, editorialType, ink, surface } from '../../../design/tokens';
import styles, { markdownStyles } from '../Course.styles';

describe('Course.styles reader sheet', () => {
  it('grounds the reader sheet and scroll on the Candle & Ink surfaces', () => {
    const readerSheet = StyleSheet.flatten(styles.readerSheet);
    const readerScroll = StyleSheet.flatten(styles.readerScroll);
    expect(readerSheet.backgroundColor).toBe(surface.canvas);
    expect(readerScroll.backgroundColor).toBe(surface.desk);
  });

  it('styles the sheet eyebrow with the muted caption face, uppercased', () => {
    const eyebrow = StyleSheet.flatten(styles.readerEyebrow);
    expect(eyebrow.color).toBe(ink.muted);
    expect(eyebrow.textTransform).toBe('uppercase');
    expect(eyebrow.fontFamily).toBe(editorialType.caption.fontFamily);
  });

  it('styles the sheet title with the serif editorial title face', () => {
    const title = StyleSheet.flatten(styles.readerTitle);
    expect(title.fontFamily).toBe(editorialType.title.fontFamily);
    expect(title.fontSize).toBe(editorialType.title.fontSize);
    expect(title.color).toBe(ink.primary);
  });

  it('draws markdown body and link text from the ink and accent tokens', () => {
    const body = StyleSheet.flatten(markdownStyles.body);
    const link = StyleSheet.flatten(markdownStyles.link);
    expect(body.color).toBe(ink.primary);
    expect(link.color).toBe(accent.primary);
  });

  it('draws the blockquote rule and hr from the accent token', () => {
    const blockquote = StyleSheet.flatten(markdownStyles.blockquote);
    const hr = StyleSheet.flatten(markdownStyles.hr);
    expect(blockquote.borderLeftColor).toBe(accent.primary);
    expect(hr.backgroundColor).toBe(accent.primary);
  });
});
