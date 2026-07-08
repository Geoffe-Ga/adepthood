import { describe, expect, it } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';

import { useMountedRef } from '../useMountedRef';

describe('useMountedRef', () => {
  it('is true while mounted', () => {
    const { result } = renderHook(() => useMountedRef());
    expect(result.current.current).toBe(true);
  });

  it('returns the same ref object across a rerender', () => {
    const { result, rerender } = renderHook(() => useMountedRef());
    const first = result.current;
    rerender({});
    expect(result.current).toBe(first);
  });

  it('flips to false after unmount', () => {
    const { result, unmount } = renderHook(() => useMountedRef());
    unmount();
    expect(result.current.current).toBe(false);
  });
});
