import { describe, expect, it } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

import { usePagination } from '../usePagination';

const PAGE_SIZE = 10;

describe('usePagination', () => {
  it('starts on page 0 with at least 1 page even for an empty list', () => {
    const { result } = renderHook(() => usePagination(0, PAGE_SIZE));
    expect(result.current.page).toBe(0);
    expect(result.current.pageCount).toBe(1);
  });

  it('reports the correct page count for a partially filled last page', () => {
    const { result } = renderHook(() => usePagination(23, PAGE_SIZE));
    expect(result.current.pageCount).toBe(3);
  });

  it('clamps prev at 0 and next at pageCount - 1', () => {
    const { result } = renderHook(() => usePagination(25, PAGE_SIZE));
    expect(result.current.page).toBe(0);
    act(() => result.current.goPrev());
    expect(result.current.page).toBe(0);
    act(() => result.current.goNext());
    expect(result.current.page).toBe(1);
    act(() => result.current.goNext());
    expect(result.current.page).toBe(2);
    act(() => result.current.goNext());
    expect(result.current.page).toBe(2);
  });

  it('goLast jumps to the last page', () => {
    const { result } = renderHook(() => usePagination(35, PAGE_SIZE));
    act(() => result.current.goLast());
    expect(result.current.page).toBe(3);
  });

  it('clamps the read value when habitCount shrinks below current page', () => {
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => usePagination(count, PAGE_SIZE),
      { initialProps: { count: 25 } },
    );
    act(() => result.current.goNext());
    act(() => result.current.goNext());
    expect(result.current.page).toBe(2);

    // List shrinks to a single page; the read value clamps without an extra render.
    rerender({ count: 5 });
    expect(result.current.pageCount).toBe(1);
    expect(result.current.page).toBe(0);
  });

  it('goLast is bound to the latest habitCount across renders', () => {
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => usePagination(count, PAGE_SIZE),
      { initialProps: { count: 5 } },
    );
    rerender({ count: 25 });
    act(() => result.current.goLast());
    expect(result.current.page).toBe(2);
  });

  it('goPrev after goLast steps back to the immediately-previous page', () => {
    const { result } = renderHook(() => usePagination(12, PAGE_SIZE));
    expect(result.current.pageCount).toBe(2);
    act(() => result.current.goLast());
    expect(result.current.page).toBe(1);
    act(() => result.current.goPrev());
    expect(result.current.page).toBe(0);
  });

  it('goNext after goLast stays on the last page', () => {
    const { result } = renderHook(() => usePagination(12, PAGE_SIZE));
    act(() => result.current.goLast());
    expect(result.current.page).toBe(1);
    act(() => result.current.goNext());
    expect(result.current.page).toBe(1);
  });
});
