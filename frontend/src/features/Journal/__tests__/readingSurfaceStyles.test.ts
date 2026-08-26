/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { buildReadingScrollStyle } from '../readingSurfaceStyles';

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
