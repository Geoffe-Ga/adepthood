/* eslint-env jest */
/* global describe, it, expect, afterEach, jest */
import { renderHook } from '@testing-library/react-native';

import { contentLayout } from '../tokens';
import useResponsive from '../useResponsive';

const mockWindowDimensions = (width: number, height: number): void => {
  jest
    .spyOn(require('react-native'), 'useWindowDimensions')
    .mockReturnValue({ width, height, scale: 1, fontScale: 1 });
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useResponsive contentWidth', () => {
  it('passes the raw width through unchanged on a phone-width viewport (below the content cap)', () => {
    mockWindowDimensions(390, 844);
    const { result } = renderHook(() => useResponsive());
    expect(result.current.contentWidth).toBe(390);
  });

  it('is a no-op exactly at the content cap boundary', () => {
    mockWindowDimensions(contentLayout.maxWidth, 900);
    const { result } = renderHook(() => useResponsive());
    expect(result.current.contentWidth).toBe(contentLayout.maxWidth);
  });

  it('caps contentWidth at contentLayout.maxWidth on an ultra-wide viewport', () => {
    mockWindowDimensions(1600, 900);
    const { result } = renderHook(() => useResponsive());
    expect(result.current.contentWidth).toBe(contentLayout.maxWidth);
    // The raw width is still reported unclamped for callers that need it.
    expect(result.current.width).toBe(1600);
  });
});
