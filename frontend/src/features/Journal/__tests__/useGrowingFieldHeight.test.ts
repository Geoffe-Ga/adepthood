import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { useEffect } from 'react';

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

const Platform = require('react-native').Platform as { OS: string };

const MIN = 100;
/** A fractional scrollHeight above MIN, so the whole-pixel rounding is observable. */
const MEASURED = 640.2;
const MEASURED_CEIL = 641;
const NATIVE_GROWTH = 300;

interface TrackedProps {
  value: string;
  ref: { current: unknown };
}

/** A host node whose scrollHeight read is observable. */
function spyNode(height: number) {
  const read = jest.fn(() => height);
  const node = {};
  Object.defineProperty(node, 'scrollHeight', { get: read });
  return { node, read };
}

describe('useGrowingFieldHeight value-keyed remeasure (#3001)', () => {
  let originalOS: string;
  let commits: number;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
    commits = 0;
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  function renderTracked(ref: { current: unknown }) {
    return renderHook(
      ({ value, ref: inputRef }: TrackedProps) => {
        const growth = useGrowingFieldHeight(MIN, { value, inputRef });
        useEffect(() => {
          commits += 1;
        });
        return growth;
      },
      { initialProps: { value: 'a', ref } },
    );
  }

  it('re-reads the web field when its value changes without an input event', () => {
    const ref = { current: null as unknown };
    const { result, rerender } = renderTracked(ref);
    expect(result.current.style.height).toBe(MIN);
    ref.current = { scrollHeight: MEASURED };
    rerender({ value: 'a\nb', ref });
    expect(result.current.style.height).toBe(MEASURED_CEIL);
  });

  it('reads nothing on native, where onContentSizeChange already follows the value', () => {
    Platform.OS = 'ios';
    const { node, read } = spyNode(MEASURED);
    const ref = { current: node as unknown };
    const { result, rerender } = renderTracked(ref);
    rerender({ value: 'a\nb', ref });
    expect(read).not.toHaveBeenCalled();
    expect(result.current.style.height).toBe(MIN);
    act(() => result.current.onContentSizeChange(grow(NATIVE_GROWTH)));
    expect(result.current.style.height).toBe(NATIVE_GROWTH);
  });

  it('commits nothing extra when a new value measures the same height', () => {
    const ref = { current: { scrollHeight: MEASURED } as unknown };
    const { result, rerender } = renderTracked(ref);
    rerender({ value: 'a\nb', ref });
    expect(result.current.style.height).toBe(MEASURED_CEIL);
    const before = commits;
    rerender({ value: 'a\nb\nc', ref });
    // The rerender's own commit, and no second one from re-measuring the same height.
    expect(commits - before).toBe(1);
    expect(result.current.style.height).toBe(MEASURED_CEIL);
  });

  it('keeps a grown height when a hidden field reports no scrollHeight', () => {
    const ref = { current: { scrollHeight: MEASURED } as unknown };
    const { result, rerender } = renderTracked(ref);
    rerender({ value: 'a\nb', ref });
    ref.current = { scrollHeight: 0 };
    rerender({ value: 'a\nb\nc', ref });
    expect(result.current.style.height).toBe(MEASURED_CEIL);
  });

  it('measures on a value change, not on every render', () => {
    const { node, read } = spyNode(MEASURED);
    const ref = { current: node as unknown };
    const { rerender } = renderTracked(ref);
    const mounted = read.mock.calls.length;
    rerender({ value: 'a', ref });
    expect(read.mock.calls.length).toBe(mounted);
    rerender({ value: 'b', ref });
    expect(read.mock.calls.length).toBe(mounted + 1);
  });
});
