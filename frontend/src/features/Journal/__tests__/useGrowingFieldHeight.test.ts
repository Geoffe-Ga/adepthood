import { describe, expect, it } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useGrowingFieldHeight } from '../useGrowingFieldHeight';

function grow(height: number) {
  return { nativeEvent: { contentSize: { height } } };
}

describe('useGrowingFieldHeight', () => {
  it('leaves an unmeasured field with no minimum unsized', () => {
    const { result } = renderHook(() => useGrowingFieldHeight());
    expect(result.current.style).toEqual({ minHeight: undefined, height: undefined });
  });

  it('starts at its minimum and never shrinks below it', () => {
    const { result } = renderHook(() => useGrowingFieldHeight(100));
    expect(result.current.style).toEqual({ minHeight: 100, height: 100 });
    act(() => result.current.onContentSizeChange(grow(40)));
    expect(result.current.style.height).toBe(100);
  });

  it('grows to the measured content, rounded up to a whole pixel', () => {
    const { result } = renderHook(() => useGrowingFieldHeight(100));
    act(() => result.current.onContentSizeChange(grow(240.2)));
    expect(result.current.style.height).toBe(241);
  });

  it('keeps the same state object when the measurement repeats', () => {
    const { result } = renderHook(() => useGrowingFieldHeight(0));
    act(() => result.current.onContentSizeChange(grow(50)));
    const before = result.current.style;
    act(() => result.current.onContentSizeChange(grow(50)));
    expect(result.current.style).toEqual(before);
    expect(result.current.style.height).toBe(50);
  });
});
