/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  buildFloatingDockStyle,
  buildPinnedFooterStyle,
  buildReadingScrollStyle,
} from '../readingSurfaceStyles';

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

describe('buildFloatingDockStyle (#3134)', () => {
  it('on web pins a zero-height dock to the foot of the scroll viewport with CSS sticky', () => {
    const style = buildFloatingDockStyle('web');
    expect(style.position).toBe('sticky');
    expect(style.bottom).toBe(0);
    // No height of its own: the dock never pushes the page flow or the footer.
    expect(style.height).toBe(0);
    expect(style.zIndex).toBeGreaterThan(0);
  });

  it.each(['ios', 'android'] as const)(
    'on %s spans the surface so the pill sits inside the bounds that take its touches',
    (platform) => {
      const style = buildFloatingDockStyle(platform);
      expect(style).toEqual(
        expect.objectContaining({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }),
      );
      expect(style.zIndex).toBeGreaterThan(0);
    },
  );
});
