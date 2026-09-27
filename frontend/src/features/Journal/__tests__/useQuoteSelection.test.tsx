import { describe, it, expect } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useQuoteSelection } from '../useQuoteSelection';

function ids(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

describe('useQuoteSelection -- which quotes a writer has checked (#2885)', () => {
  it('starts out of selection mode with nothing checked', () => {
    const { result } = renderHook(() => useQuoteSelection());
    expect(result.current.selecting).toBe(false);
    expect(ids(result.current.selected)).toEqual([]);
  });

  it('toggles one quote on and off', () => {
    const { result } = renderHook(() => useQuoteSelection());
    act(() => result.current.toggle(4));
    expect(ids(result.current.selected)).toEqual([4]);
    act(() => result.current.toggle(4));
    expect(ids(result.current.selected)).toEqual([]);
  });

  it('selects all of the ids it is given, and clears them all', () => {
    const { result } = renderHook(() => useQuoteSelection());
    act(() => result.current.toggle(9));
    act(() => result.current.selectAll([1, 2, 3]));
    expect(ids(result.current.selected)).toEqual([1, 2, 3]);
    act(() => result.current.clear());
    expect(ids(result.current.selected)).toEqual([]);
  });

  it('keeps only the ids a batch left behind, never checking one that was not', () => {
    const { result } = renderHook(() => useQuoteSelection());
    act(() => result.current.selectAll([1, 2, 3]));
    act(() => result.current.keepOnly([2, 7]));
    expect(ids(result.current.selected)).toEqual([2]);
  });

  it('keeps the same set when every checked id is still listed', () => {
    const { result } = renderHook(() => useQuoteSelection());
    act(() => result.current.selectAll([1, 2, 3]));
    const before = result.current.selected;
    act(() => result.current.keepOnly([1, 2, 3, 4]));
    expect(result.current.selected).toBe(before);
  });

  it('entering and leaving the mode drops any selection', () => {
    const { result } = renderHook(() => useQuoteSelection());
    act(() => result.current.toggleMode());
    expect(result.current.selecting).toBe(true);
    act(() => result.current.toggle(1));
    act(() => result.current.toggleMode());
    expect(result.current.selecting).toBe(false);
    expect(ids(result.current.selected)).toEqual([]);
  });
});
