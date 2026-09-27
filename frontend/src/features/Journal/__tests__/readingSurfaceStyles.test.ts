/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { buildPinnedFooterStyle, buildReadingScrollStyle } from '../readingSurfaceStyles';

describe('buildReadingScrollStyle', () => {
  it('reserves a stable scrollbar gutter on web so the bar never paints over the entry', () => {
    const style = buildReadingScrollStyle('web');
    expect(style.scrollbarGutter).toBe('stable');
    expect(Object.keys(style).length).toBeGreaterThan(0);
  });

  it('adds nothing on ios, so the web gutter cannot shift native layout', () => {
    expect(buildReadingScrollStyle('ios')).toEqual({});
  });

  it('adds nothing on android, so the web gutter cannot shift native layout', () => {
    expect(buildReadingScrollStyle('android')).toEqual({});
  });
});

describe('buildPinnedFooterStyle (#2952)', () => {
  it('pins a footer to the bottom of the scroll viewport on web with CSS sticky', () => {
    const style = buildPinnedFooterStyle('web');
    expect(style.position).toBe('sticky');
    expect(style.bottom).toBe(0);
  });

  it('adds nothing on ios, where the row stays in the page flow', () => {
    expect(buildPinnedFooterStyle('ios')).toEqual({});
  });

  it('adds nothing on android, where the row stays in the page flow', () => {
    expect(buildPinnedFooterStyle('android')).toEqual({});
  });
});
