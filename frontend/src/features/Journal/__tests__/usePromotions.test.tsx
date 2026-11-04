/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { PromotedQuote } from '@/api';
import { ApiError } from '@/api';

/** A never-settling promise plus its resolve, for pinning in-flight state. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (_value: T) => void;
} {
  let resolve: (_value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A pending promoted quote anchored near the head of a body. */
function quote(overrides: Partial<PromotedQuote> = {}): PromotedQuote {
  return {
    id: 1,
    source_kind: 'entry',
    source_entry_id: 7,
    source_content_id: null,
    source_marginalia_id: null,
    anchor_start: 2,
    anchor_end: 19,
    anchor_text: 'went for a run to',
    pending: true,
    stale: false,
    ...overrides,
  };
}

const mockCreate = jest.fn() as jest.MockedFunction<
  (_entryId: number, _span: { anchor_start: number; anchor_end: number }) => Promise<PromotedQuote>
>;
const mockRemove = jest.fn() as jest.MockedFunction<(_id: number) => Promise<void>>;
const mockList = jest.fn() as jest.MockedFunction<(_entryId: number) => Promise<PromotedQuote[]>>;
type SpanCreate = (
  _sourceId: number,
  _span: { anchor_start: number; anchor_end: number },
) => Promise<PromotedQuote>;
const mockCreateForCourse = jest.fn() as jest.MockedFunction<SpanCreate>;
const mockCreateForLetter = jest.fn() as jest.MockedFunction<SpanCreate>;
const mockListForCourse = jest.fn() as jest.MockedFunction<
  (_contentId: number) => Promise<PromotedQuote[]>
>;
const mockListForLetter = jest.fn() as jest.MockedFunction<
  (_marginaliaId: number) => Promise<PromotedQuote[]>
>;

/** Forward a call to a mock declared after ``jest.mock`` is hoisted. */
const forward =
  (mock: unknown) =>
  (...a: unknown[]): unknown =>
    (mock as (...x: unknown[]) => unknown)(...a);

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    promotions: {
      create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
      remove: (...a: unknown[]) => (mockRemove as unknown as (...x: unknown[]) => unknown)(...a),
      setIncluded: jest.fn(),
      list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
      createForCourse: (...a: unknown[]) => forward(mockCreateForCourse)(...a),
      listForCourse: (...a: unknown[]) => forward(mockListForCourse)(...a),
      createForLetter: (...a: unknown[]) => forward(mockCreateForLetter)(...a),
      listForLetter: (...a: unknown[]) => forward(mockListForLetter)(...a),
    },
  };
});

const { usePromotions, PROMOTED_NOTICE_MS } = require('../usePromotions');

beforeEach(() => {
  mockCreate.mockReset();
  mockRemove.mockReset();
  mockList.mockReset();
  mockList.mockResolvedValue([]);
  mockCreateForCourse.mockReset();
  mockCreateForLetter.mockReset();
  for (const mock of [mockListForCourse, mockListForLetter]) {
    mock.mockReset();
    mock.mockResolvedValue([]);
  }
});

describe('usePromotions', () => {
  it('seeds its quote list from initialQuotes', () => {
    const seeded = quote({ id: 5 });
    const { result } = renderHook(() =>
      usePromotions({ target: { kind: 'entry', entryId: 7 }, initialQuotes: [seeded] }),
    );
    expect(result.current.quotes).toEqual([seeded]);
  });

  it('defaults to an empty quote list with no initialQuotes', () => {
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));
    expect(result.current.quotes).toEqual([]);
  });

  it('promote calls promotions.create with the entry id and the exact span', async () => {
    mockCreate.mockResolvedValue(quote({ id: 9 }));
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));

    await act(async () => {
      await result.current.promote(2, 19);
    });
    expect(mockCreate).toHaveBeenCalledWith(7, { anchor_start: 2, anchor_end: 19 });
  });

  it('promote appends the returned quote on 201', async () => {
    mockCreate.mockResolvedValue(quote({ id: 9 }));
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));

    await act(async () => {
      await result.current.promote(2, 19);
    });
    expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([9]);
  });

  it('promote maps an error to a non-blocking hint and does not append a quote', async () => {
    mockCreate.mockRejectedValue(new ApiError(422, 'anchor_out_of_range'));
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));

    await act(async () => {
      await result.current.promote(0, 9999);
    });
    expect(result.current.quotes).toEqual([]);
    expect(result.current.hint).toBeTruthy();
  });

  it('removePromotion optimistically removes the quote', async () => {
    mockRemove.mockResolvedValue(undefined);
    const seeded = quote({ id: 5 });
    const { result } = renderHook(() =>
      usePromotions({ target: { kind: 'entry', entryId: 7 }, initialQuotes: [seeded] }),
    );

    await act(async () => {
      await result.current.removePromotion(5);
    });
    expect(result.current.quotes).toEqual([]);
    expect(mockRemove).toHaveBeenCalledWith(5);
  });

  it('a failed removePromotion clears a pending promote retry so the notice is not mis-contexted', async () => {
    mockCreate.mockRejectedValue(new ApiError(422, 'anchor_out_of_range'));
    mockRemove.mockRejectedValue(new ApiError(500, 'boom'));
    const seeded = quote({ id: 5 });
    const { result } = renderHook(() =>
      usePromotions({ target: { kind: 'entry', entryId: 7 }, initialQuotes: [seeded] }),
    );

    await act(async () => {
      await result.current.promote(0, 9999);
    });
    expect(result.current.retryPromote).not.toBeNull();

    await act(async () => {
      await result.current.removePromotion(5);
    });
    expect(result.current.retryPromote).toBeNull();
    expect(result.current.hint).toBeTruthy();
  });

  it('removePromotion reverts the optimistic removal on error and sets a hint', async () => {
    mockRemove.mockRejectedValue(new ApiError(500, 'boom'));
    const seeded = quote({ id: 5 });
    const { result } = renderHook(() =>
      usePromotions({ target: { kind: 'entry', entryId: 7 }, initialQuotes: [seeded] }),
    );

    await act(async () => {
      await result.current.removePromotion(5);
    });
    expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([5]); // reverted
    expect(result.current.hint).toBeTruthy();
  });

  it('removePromotion guards a double-tap on the same id (no second network call)', async () => {
    let resolveRemove: () => void = () => {};
    mockRemove.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRemove = resolve;
      }),
    );
    const seeded = quote({ id: 5 });
    const { result } = renderHook(() =>
      usePromotions({ target: { kind: 'entry', entryId: 7 }, initialQuotes: [seeded] }),
    );

    await act(async () => {
      void result.current.removePromotion(5);
      void result.current.removePromotion(5); // second tap while the first is in flight
      resolveRemove();
    });
    await waitFor(() => expect(result.current.quotes).toEqual([]));
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('hydrates its quote list from promotions.list on mount, sorted by anchor then id', async () => {
    const hydrated = [quote({ id: 20, anchor_start: 15 }), quote({ id: 3, anchor_start: 1 })];
    mockList.mockResolvedValue(hydrated);
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));

    await waitFor(() =>
      expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([3, 20]),
    );
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledWith(7);
  });

  it('on hydration, a fetched quote wins an id collision with a seeded quote', async () => {
    const seeded = quote({ id: 5, anchor_text: 'stale in-memory copy' });
    const fetched = quote({ id: 5, anchor_text: 'fresh server copy' });
    mockList.mockResolvedValue([fetched]);
    const { result } = renderHook(() =>
      usePromotions({ target: { kind: 'entry', entryId: 7 }, initialQuotes: [seeded] }),
    );

    await waitFor(() =>
      expect(result.current.quotes.map((q: PromotedQuote) => q.anchor_text)).toEqual([
        'fresh server copy',
      ]),
    );
  });

  it('never calls promotions.list when entryId is 0 (unsaved entry)', async () => {
    renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 0 } }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('a hydration failure sets a non-blocking hint and leaves quotes empty', async () => {
    mockList.mockRejectedValue(new ApiError(500, 'boom'));
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));

    await waitFor(() => expect(result.current.hint).toBeTruthy());
    expect(result.current.quotes).toEqual([]);
  });

  it('does not drop a quote added via promote when hydration resolves after it', async () => {
    let resolveList: (_value: PromotedQuote[]) => void = () => {};
    mockList.mockReturnValue(
      new Promise<PromotedQuote[]>((resolve) => {
        resolveList = resolve;
      }),
    );
    mockCreate.mockResolvedValue(quote({ id: 9, anchor_start: 30, anchor_end: 49 }));
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));

    await act(async () => {
      await result.current.promote(30, 49);
    });
    expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([9]);

    await act(async () => {
      resolveList([quote({ id: 3, anchor_start: 1, anchor_end: 2 })]);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([3, 9]),
    );
  });

  it('resets to empty on an entryId change so a prior entry cannot union into the new one', async () => {
    mockList.mockResolvedValueOnce([quote({ id: 5, anchor_start: 1 })]);
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => usePromotions({ target: { kind: 'entry', entryId: id } }),
      { initialProps: { id: 7 } },
    );
    await waitFor(() => expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([5]));

    mockList.mockResolvedValueOnce([quote({ id: 8, anchor_start: 2 })]);
    rerender({ id: 9 });

    await waitFor(() => expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([8]));
    expect(mockList).toHaveBeenNthCalledWith(2, 9);
  });

  it('promoting is false initially, true while the create POST is in flight, false after it resolves', async () => {
    const { promise, resolve } = deferred<PromotedQuote>();
    mockCreate.mockReturnValue(promise);
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));
    expect(result.current.promoting).toBe(false);

    let promotePromise: Promise<void> = Promise.resolve();
    act(() => {
      promotePromise = result.current.promote(2, 19);
    });
    expect(result.current.promoting).toBe(true);

    await act(async () => {
      resolve(quote({ id: 9 }));
      await promotePromise;
    });
    expect(result.current.promoting).toBe(false);
  });

  it('promoting returns to false after a create rejection', async () => {
    mockCreate.mockRejectedValue(new ApiError(422, 'boom'));
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));

    await act(async () => {
      await result.current.promote(2, 19);
    });
    expect(result.current.promoting).toBe(false);
  });

  it('promoted is false initially, true after a successful promote, and auto-clears after PROMOTED_NOTICE_MS', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(quote({ id: 9 }));
      const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));
      expect(result.current.promoted).toBe(false);

      await act(async () => {
        await result.current.promote(2, 19);
      });
      expect(result.current.promoted).toBe(true);

      act(() => {
        jest.advanceTimersByTime(PROMOTED_NOTICE_MS);
      });
      expect(result.current.promoted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retryPromote is null until a promote fails, then re-posts the same span and clears on success', async () => {
    mockCreate.mockRejectedValueOnce(new ApiError(500, 'boom'));
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));
    expect(result.current.retryPromote).toBeNull();

    await act(async () => {
      await result.current.promote(2, 19);
    });
    expect(result.current.retryPromote).not.toBeNull();

    mockCreate.mockResolvedValueOnce(quote({ id: 9 }));
    await act(async () => {
      await result.current.retryPromote!();
    });
    expect(mockCreate).toHaveBeenNthCalledWith(2, 7, { anchor_start: 2, anchor_end: 19 });
    expect(result.current.retryPromote).toBeNull();
    expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([9]);
  });

  it('a failed removePromotion sets a hint and leaves retryPromote null', async () => {
    mockRemove.mockRejectedValue(new ApiError(500, 'boom'));
    const seeded = quote({ id: 5 });
    const { result } = renderHook(() =>
      usePromotions({ target: { kind: 'entry', entryId: 7 }, initialQuotes: [seeded] }),
    );

    await act(async () => {
      await result.current.removePromotion(5);
    });
    expect(result.current.hint).toBeTruthy();
    expect(result.current.retryPromote).toBeNull();
  });

  it('clears the pending promoted-notice timer on unmount so no callback leaks', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(quote({ id: 9 }));
      const { result, unmount } = renderHook(() =>
        usePromotions({ target: { kind: 'entry', entryId: 7 } }),
      );

      await act(async () => {
        await result.current.promote(2, 19);
      });
      expect(result.current.promoted).toBe(true);
      // The auto-clear timer is armed while the notice is showing.
      expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1);

      const cleared = jest.spyOn(globalThis, 'clearTimeout');
      unmount();

      // Unmount must clear the hook's timer; a leaked one would later fire its
      // state update on a torn-down hook.
      //
      // Asserted against clearTimeout rather than a global pending-timer count.
      // The count is not the hook's to control: React 19 and the testing library
      // keep their own timers in flight, so `getTimerCount() === 0` measures the
      // environment and fails for reasons that have nothing to do with this hook.
      expect(cleared).toHaveBeenCalled();
      cleared.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('usePromotions.refresh -- reflect server re-anchoring after an edit (#2891)', () => {
  it('replaces each quote with the server copy: new offsets and the stale flag', async () => {
    const before = quote({ id: 1, anchor_start: 2, anchor_end: 19 });
    const other = quote({ id: 2, anchor_start: 30, anchor_end: 35, anchor_text: 'later' });
    mockList.mockResolvedValueOnce([before, other]);
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));
    await waitFor(() => expect(result.current.quotes).toHaveLength(2));

    const moved = { ...before, anchor_start: 12, anchor_end: 29 };
    const staled = { ...other, stale: true };
    mockList.mockResolvedValueOnce([moved, staled]);
    await act(async () => {
      await result.current.refresh();
    });

    expect(mockList).toHaveBeenLastCalledWith(7);
    expect(result.current.quotes).toEqual([moved, staled]);
  });

  it('is a no-op for an unsaved entry', async () => {
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 0 } }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('keeps the list and raises a content-free hint when the refetch fails', async () => {
    const seeded = quote({ id: 1, anchor_text: 'a very private sentence' });
    mockList.mockResolvedValueOnce([seeded]);
    const { result } = renderHook(() => usePromotions({ target: { kind: 'entry', entryId: 7 } }));
    await waitFor(() => expect(result.current.quotes).toHaveLength(1));

    mockList.mockRejectedValueOnce(new ApiError(503, 'service_unavailable'));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.quotes).toEqual([seeded]);
    expect(result.current.hint).toBeTruthy();
    expect(result.current.hint).not.toContain('private sentence');
  });

  it('drops a response that lands after the entry changed', async () => {
    mockList.mockResolvedValue([]);
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => usePromotions({ target: { kind: 'entry', entryId: id } }),
      { initialProps: { id: 7 } },
    );
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(7));
    const late = deferred<PromotedQuote[]>();
    mockList.mockReturnValueOnce(late.promise);
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.refresh();
    });
    rerender({ id: 8 });
    await act(async () => {
      late.resolve([quote({ id: 99, source_entry_id: 7 })]);
      await pending;
    });
    expect(result.current.quotes.map((q: PromotedQuote) => q.id)).not.toContain(99);
  });
});

/**
 * A chapter or a letter promotes through the same hook (#3660): one target,
 * the same single-flight guard and the same notice, and a failure worded for
 * the source the reader was quoting from.
 */
describe('usePromotions -- reading targets', () => {
  const COURSE = { kind: 'course', contentId: 4 } as const;
  const LETTER = { kind: 'letter', marginaliaId: 9 } as const;

  it('promotes a chapter span through createForCourse, never the entry route', async () => {
    mockCreateForCourse.mockResolvedValue(quote({ id: 31, source_kind: 'course' }));
    const { result } = renderHook(() => usePromotions({ target: COURSE }));

    await act(async () => {
      await result.current.promote(22, 26);
    });

    expect(mockCreateForCourse).toHaveBeenCalledWith(4, { anchor_start: 22, anchor_end: 26 });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([31]);
    expect(result.current.promoted).toBe(true);
  });

  it('promotes a letter span through createForLetter', async () => {
    mockCreateForLetter.mockResolvedValue(quote({ id: 32, source_kind: 'letter' }));
    const { result } = renderHook(() => usePromotions({ target: LETTER }));

    await act(async () => {
      await result.current.promote(3, 12);
    });

    expect(mockCreateForLetter).toHaveBeenCalledWith(9, { anchor_start: 3, anchor_end: 12 });
    expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([32]);
  });

  it('hydrates a letter through listForLetter and a chapter through listForCourse', async () => {
    mockListForLetter.mockResolvedValue([quote({ id: 40, source_kind: 'letter' })]);
    mockListForCourse.mockResolvedValue([quote({ id: 41, source_kind: 'course' })]);

    const letter = renderHook(() => usePromotions({ target: LETTER }));
    const chapter = renderHook(() => usePromotions({ target: COURSE }));

    await waitFor(() =>
      expect(letter.result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([40]),
    );
    await waitFor(() =>
      expect(chapter.result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([41]),
    );
    expect(mockListForLetter).toHaveBeenCalledWith(9);
    expect(mockListForCourse).toHaveBeenCalledWith(4);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('reads nothing on open when the caller draws no highlights (hydrate: false)', async () => {
    renderHook(() => usePromotions({ target: COURSE, hydrate: false }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockListForCourse).not.toHaveBeenCalled();
  });

  it('starts reading once hydration is switched on (a letter that has just arrived)', async () => {
    mockListForLetter.mockResolvedValue([quote({ id: 40, source_kind: 'letter' })]);
    const { result, rerender } = renderHook(
      ({ hydrate }: { hydrate: boolean }) => usePromotions({ target: LETTER, hydrate }),
      { initialProps: { hydrate: false } },
    );
    expect(mockListForLetter).not.toHaveBeenCalled();

    rerender({ hydrate: true });

    await waitFor(() =>
      expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([40]),
    );
  });

  it('does not union one kind into another that happens to share its id', async () => {
    mockList.mockResolvedValueOnce([quote({ id: 5, anchor_start: 1 })]);
    mockListForLetter.mockResolvedValueOnce([quote({ id: 6, source_kind: 'letter' })]);
    const { result, rerender } = renderHook(
      ({ target }: { target: { kind: 'entry'; entryId: number } | typeof LETTER }) =>
        usePromotions({ target }),
      { initialProps: { target: { kind: 'entry', entryId: 9 } } },
    );
    await waitFor(() => expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([5]));

    rerender({ target: LETTER });

    await waitFor(() => expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([6]));
  });

  it('words a failed chapter promote for the chapter, and offers the same retry', async () => {
    mockCreateForCourse.mockRejectedValueOnce(new ApiError(404, 'content_not_found'));
    const { result } = renderHook(() => usePromotions({ target: COURSE, hydrate: false }));

    await act(async () => {
      await result.current.promote(22, 26);
    });
    expect(result.current.hint).toMatch(/^This chapter isn't open to you yet/);
    expect(result.current.retryPromote).not.toBeNull();

    mockCreateForCourse.mockResolvedValueOnce(quote({ id: 31, source_kind: 'course' }));
    await act(async () => {
      await result.current.retryPromote?.();
    });
    expect(mockCreateForCourse).toHaveBeenLastCalledWith(4, { anchor_start: 22, anchor_end: 26 });
    expect(result.current.hint).toBeNull();
  });

  it('words a refused letter promote for the Intimate page it answered', async () => {
    mockCreateForLetter.mockRejectedValueOnce(new ApiError(409, 'quote_source_restricted'));
    const { result } = renderHook(() => usePromotions({ target: LETTER, hydrate: false }));

    await act(async () => {
      await result.current.promote(3, 12);
    });

    expect(result.current.hint).toMatch(/page this letter answered is marked Intimate/);
  });

  it('keeps a reading promote single-flight: a double tap posts once', async () => {
    const pending = deferred<PromotedQuote>();
    mockCreateForLetter.mockReturnValue(pending.promise);
    const { result } = renderHook(() => usePromotions({ target: LETTER, hydrate: false }));

    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.promote(3, 12);
      void result.current.promote(3, 12);
    });
    expect(result.current.promoting).toBe(true);

    await act(async () => {
      pending.resolve(quote({ id: 32, source_kind: 'letter' }));
      await first;
    });
    expect(mockCreateForLetter).toHaveBeenCalledTimes(1);
    expect(result.current.promoting).toBe(false);
  });
});
