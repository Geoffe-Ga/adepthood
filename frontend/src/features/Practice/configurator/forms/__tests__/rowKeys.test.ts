import { describe, expect, it } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { makeRowKeyFactory, useStableRowKeys } from '../rowKeys';

describe('useStableRowKeys', () => {
  it('seeds one key per initial row, stable across a re-render', () => {
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => useStableRowKeys('prompt', count),
      { initialProps: { count: 3 } },
    );
    const before = [0, 1, 2].map((i) => result.current.keyAt(i));

    rerender({ count: 3 });

    const after = [0, 1, 2].map((i) => result.current.keyAt(i));
    expect(after).toEqual(before);
  });

  it('append yields a fresh key distinct from every existing key', () => {
    const { result } = renderHook(() => useStableRowKeys('prompt', 2));
    const existing = [result.current.keyAt(0), result.current.keyAt(1)];

    act(() => {
      result.current.append();
    });

    expect(existing).not.toContain(result.current.keyAt(2));
  });

  it('remove(0) shifts the surviving keys down without renaming them', () => {
    const { result } = renderHook(() => useStableRowKeys('prompt', 3));
    const survivorOne = result.current.keyAt(1);
    const survivorTwo = result.current.keyAt(2);

    act(() => {
      result.current.remove(0);
    });

    expect(result.current.keyAt(0)).toBe(survivorOne);
    expect(result.current.keyAt(1)).toBe(survivorTwo);
  });

  it('swap(0, 1) exchanges the keys at those two indices', () => {
    const { result } = renderHook(() => useStableRowKeys('prompt', 3));
    const keyZero = result.current.keyAt(0);
    const keyOne = result.current.keyAt(1);

    act(() => {
      result.current.swap(0, 1);
    });

    expect(result.current.keyAt(0)).toBe(keyOne);
    expect(result.current.keyAt(1)).toBe(keyZero);
  });

  it('swap with an out-of-range index is a no-op', () => {
    const { result } = renderHook(() => useStableRowKeys('prompt', 2));
    const keyZero = result.current.keyAt(0);
    const keyOne = result.current.keyAt(1);

    act(() => {
      result.current.swap(0, 5);
    });

    expect(result.current.keyAt(0)).toBe(keyZero);
    expect(result.current.keyAt(1)).toBe(keyOne);
  });

  it('keyAt beyond range returns a deterministic fallback', () => {
    const { result } = renderHook(() => useStableRowKeys('prompt', 2));
    expect(result.current.keyAt(5)).toBe('prompt-fallback-5');
  });
});

describe('makeRowKeyFactory', () => {
  it('emits sequential, underscore-separated keys', () => {
    const factory = makeRowKeyFactory('option');
    expect(factory()).toBe('option_1');
    expect(factory()).toBe('option_2');
  });

  it('keeps two independently-created factories on separate counters', () => {
    const options = makeRowKeyFactory('option');
    const categories = makeRowKeyFactory('category');

    expect(options()).toBe('option_1');
    expect(categories()).toBe('category_1');
    expect(options()).toBe('option_2');
  });

  it('emits values that match the backend key pattern', () => {
    const factory = makeRowKeyFactory('category');
    const keyPattern = /^[a-z][a-z0-9_]*$/;

    expect(keyPattern.test(factory())).toBe(true);
    expect(keyPattern.test(factory())).toBe(true);
    expect(keyPattern.test(factory())).toBe(true);
  });
});
