/* eslint-env jest */
/* global describe, it, expect, jest */
import { renderHook } from '@testing-library/react-native';
import React from 'react';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import useResponsive from '../../../design/useResponsive';
import { useTileLayout } from '../HabitTile';

jest.mock('../../../design/useResponsive', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockedUseResponsive = jest.mocked(useResponsive);

const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <SafeAreaInsetsContext.Provider value={{ top: 0, bottom: 0, left: 0, right: 0 }}>
    {children}
  </SafeAreaInsetsContext.Provider>
);

describe('useTileLayout content-width clamp', () => {
  it('derives iconInline from the capped contentWidth, not the raw window width, on an ultra-wide viewport', () => {
    // A raw width far beyond the shared content cap would keep a 2-column
    // tile comfortably above the 400px icon-inline threshold if the hook
    // used it directly; the capped contentWidth (well below the cap) must
    // drive the calculation instead.
    const NARROW_CAPPED_WIDTH = 300;
    mockedUseResponsive.mockReturnValue({
      width: 4000,
      contentWidth: NARROW_CAPPED_WIDTH,
      height: 900,
      columns: 2,
      scale: 1,
      gridGutter: 8,
      // Breakpoint flags are part of the hook's return contract but unused by
      // useTileLayout; set consistent with the raw (ultra-wide) width.
      isXS: false,
      isSM: false,
      isMD: false,
      isLG: false,
      isXL: true,
    });

    const { result } = renderHook(() => useTileLayout(), { wrapper });

    expect(result.current.iconInline).toBe(true);
  });

  it('keeps iconInline false off a wide contentWidth even when the raw window width alone would read narrow', () => {
    // The inverse case: a small raw width (which alone would cross below the
    // 400px threshold and force the compact inline layout) paired with a wide
    // contentWidth. The hook must key off contentWidth, not width.
    const NARROW_RAW_WIDTH = 100;
    const WIDE_CAPPED_WIDTH = 900;
    mockedUseResponsive.mockReturnValue({
      width: NARROW_RAW_WIDTH,
      contentWidth: WIDE_CAPPED_WIDTH,
      height: 900,
      columns: 2,
      scale: 1,
      gridGutter: 8,
      // Breakpoint flags are part of the hook's return contract but unused by
      // useTileLayout; set consistent with the raw (narrow) width.
      isXS: true,
      isSM: false,
      isMD: false,
      isLG: false,
      isXL: false,
    });

    const { result } = renderHook(() => useTileLayout(), { wrapper });

    expect(result.current.iconInline).toBe(false);
  });
});
