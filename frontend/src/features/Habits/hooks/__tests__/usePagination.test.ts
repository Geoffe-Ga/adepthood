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
    // 3 program pages plus the permanent gated leading carryover invite lap.
    const { result } = renderHook(() => usePagination(23, PAGE_SIZE));
    expect(result.current.pageCount).toBe(4);
  });

  it('clamps prev at the leading invite lap and next at maxPage', () => {
    const { result } = renderHook(() => usePagination(25, PAGE_SIZE));
    expect(result.current.page).toBe(0);
    act(() => result.current.goPrev());
    expect(result.current.page).toBe(-1);
    act(() => result.current.goPrev());
    expect(result.current.page).toBe(-1);
    act(() => result.current.goNext());
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

    // List shrinks to one content page (plus the leading invite lap); the read
    // value clamps without an extra render.
    rerender({ count: 5 });
    expect(result.current.pageCount).toBe(2);
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
    expect(result.current.pageCount).toBe(3);
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

// Second habit set (stages 11-20): a trailing invite page appears once every
// slot on the current lap is filled, inviting the user into the next lap.
describe('usePagination trailing invite page', () => {
  it('adds a trailing invite page when count is an exact multiple of pageSize', () => {
    expect(renderHook(() => usePagination(10, PAGE_SIZE)).result.current.pageCount).toBe(3);
    expect(renderHook(() => usePagination(20, PAGE_SIZE)).result.current.pageCount).toBe(4);
    expect(renderHook(() => usePagination(30, PAGE_SIZE)).result.current.pageCount).toBe(5);
  });

  it('adds no trailing invite for a partial last lap; an empty list stays one page', () => {
    expect(renderHook(() => usePagination(15, PAGE_SIZE)).result.current.pageCount).toBe(3);
    expect(renderHook(() => usePagination(0, PAGE_SIZE)).result.current.pageCount).toBe(1);
  });

  it('goNext can advance into the trailing invite page once the last content page is full', () => {
    const { result } = renderHook(() => usePagination(10, PAGE_SIZE));
    expect(result.current.page).toBe(0);
    act(() => result.current.goNext());
    expect(result.current.page).toBe(1);
  });

  it('goLast retargets to the last content page, not the invite page, when count exactly fills whole pages', () => {
    const ten = renderHook(() => usePagination(10, PAGE_SIZE));
    expect(ten.result.current.pageCount).toBe(3);
    act(() => ten.result.current.goLast());
    expect(ten.result.current.page).toBe(0);

    const twenty = renderHook(() => usePagination(20, PAGE_SIZE));
    expect(twenty.result.current.pageCount).toBe(4);
    act(() => twenty.result.current.goLast());
    expect(twenty.result.current.page).toBe(1);
  });

  it('goLast still lands on the last content page for counts that do not exactly fill a page', () => {
    const eleven = renderHook(() => usePagination(11, PAGE_SIZE));
    act(() => eleven.result.current.goLast());
    expect(eleven.result.current.page).toBe(1);

    const twentyOne = renderHook(() => usePagination(21, PAGE_SIZE));
    act(() => twentyOne.result.current.goLast());
    expect(twentyOne.result.current.page).toBe(2);
  });

  it('growing from a partial page to an exact multiple adds the invite page, and goLast stays on the content page', () => {
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => usePagination(count, PAGE_SIZE),
      { initialProps: { count: 9 } },
    );
    expect(result.current.pageCount).toBe(2);
    rerender({ count: 10 });
    expect(result.current.pageCount).toBe(3);
    act(() => result.current.goLast());
    expect(result.current.page).toBe(0);
  });

  it('a goLast captured before an append lands on the appended row, not the stale last page', () => {
    // Reproduces the add flow: the screen captures goLast at count=10 (last
    // content page 0), the append raises the count to 11 (new row on page 1),
    // and only then does the captured callback run. It must target the row the
    // user just created, so goLast reads the live count rather than the render
    // it was created in.
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => usePagination(count, PAGE_SIZE),
      { initialProps: { count: 10 } },
    );
    const capturedGoLast = result.current.goLast;
    rerender({ count: 11 });
    act(() => capturedGoLast());
    expect(result.current.page).toBe(1);
  });
});

// Signed pagination: carryover habits live on negative laps before the program
// lap. A deeper negative lap opens only when the shallower lap is exactly full
// (leading-invite mirror of the trailing invite page).
describe('usePagination signed carryover laps', () => {
  it('opens one leading invite lap when the program has habits but no carryover yet', () => {
    const { result } = renderHook(() => usePagination(23, PAGE_SIZE, 0));
    expect(result.current.pageCount).toBe(4);
    expect(result.current.minPage).toBe(-1);
    expect(result.current.maxPage).toBe(2);
    expect(result.current.canPrev).toBe(true);
    expect(result.current.canNext).toBe(true);
  });

  it('exposes a leading carryover lap alongside the trailing invite page', () => {
    const { result } = renderHook(() => usePagination(10, PAGE_SIZE, 3));
    expect(result.current.page).toBe(0);
    expect(result.current.maxPage).toBe(1);
    expect(result.current.minPage).toBe(-1);
    expect(result.current.pageCount).toBe(3);
    expect(result.current.canPrev).toBe(true);
    expect(result.current.canNext).toBe(true);
  });

  it('opens a deeper leading-invite lap only when the shallower lap holds exactly a full page', () => {
    expect(renderHook(() => usePagination(0, PAGE_SIZE, 10)).result.current.minPage).toBe(-2);
    expect(renderHook(() => usePagination(0, PAGE_SIZE, 11)).result.current.minPage).toBe(-2);
    expect(renderHook(() => usePagination(0, PAGE_SIZE, 3)).result.current.minPage).toBe(-1);
    expect(renderHook(() => usePagination(0, PAGE_SIZE, 0)).result.current.minPage).toBe(0);
  });

  it('goPrev steps progressively down to minPage and clamps there', () => {
    const { result } = renderHook(() => usePagination(10, PAGE_SIZE, 10));
    expect(result.current.minPage).toBe(-2);
    expect(result.current.page).toBe(0);
    act(() => result.current.goPrev());
    expect(result.current.page).toBe(-1);
    expect(result.current.canPrev).toBe(true);
    act(() => result.current.goPrev());
    expect(result.current.page).toBe(-2);
    expect(result.current.canPrev).toBe(false);
    act(() => result.current.goPrev());
    expect(result.current.page).toBe(-2);
  });

  it('goNext clamps at maxPage with canNext false', () => {
    const { result } = renderHook(() => usePagination(10, PAGE_SIZE, 3));
    act(() => result.current.goNext());
    expect(result.current.page).toBe(1);
    expect(result.current.canNext).toBe(false);
    act(() => result.current.goNext());
    expect(result.current.page).toBe(1);
  });

  it('starts on the program lap (page 0) even when negative laps exist', () => {
    expect(renderHook(() => usePagination(5, PAGE_SIZE, 5)).result.current.page).toBe(0);
    expect(renderHook(() => usePagination(10, PAGE_SIZE, 10)).result.current.page).toBe(0);
  });
});

// The negative mirror of goLast: after a carryover add, the screen jumps to
// the negative lap that holds the newest carryover habit.
describe('usePagination goFirstCarryover', () => {
  it('lands on lap -1 once the first carryover exists', () => {
    const { result } = renderHook(() => usePagination(5, PAGE_SIZE, 1));
    act(() => result.current.goFirstCarryover());
    expect(result.current.page).toBe(-1);
  });

  it('targets the deeper lap that holds the newest carryover', () => {
    const { result } = renderHook(() => usePagination(5, PAGE_SIZE, 11));
    act(() => result.current.goFirstCarryover());
    expect(result.current.page).toBe(-2);
  });

  it('a goFirstCarryover captured before an append reads the live carryover count', () => {
    // Mirror of the captured-goLast test: the add flow captures the callback
    // before the append re-renders, so it must read the count via a ref.
    const { result, rerender } = renderHook(
      ({ carryover }: { carryover: number }) => usePagination(5, PAGE_SIZE, carryover),
      { initialProps: { carryover: 0 } },
    );
    const capturedGoFirstCarryover = result.current.goFirstCarryover;
    rerender({ carryover: 1 });
    act(() => capturedGoFirstCarryover());
    expect(result.current.page).toBe(-1);
  });
});
