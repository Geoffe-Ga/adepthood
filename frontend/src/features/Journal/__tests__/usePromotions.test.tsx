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
    source_entry_id: 7,
    anchor_start: 2,
    anchor_end: 19,
    anchor_text: 'went for a run to',
    pending: true,
    ...overrides,
  };
}

const mockCreate = jest.fn() as jest.MockedFunction<
  (_entryId: number, _span: { anchor_start: number; anchor_end: number }) => Promise<PromotedQuote>
>;
const mockRemove = jest.fn() as jest.MockedFunction<(_id: number) => Promise<void>>;
const mockList = jest.fn() as jest.MockedFunction<(_entryId: number) => Promise<PromotedQuote[]>>;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    promotions: {
      create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
      remove: (...a: unknown[]) => (mockRemove as unknown as (...x: unknown[]) => unknown)(...a),
      setIncluded: jest.fn(),
      list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

const { usePromotions, PROMOTED_NOTICE_MS } = require('../usePromotions');

beforeEach(() => {
  mockCreate.mockReset();
  mockRemove.mockReset();
  mockList.mockReset();
  mockList.mockResolvedValue([]);
});

describe('usePromotions', () => {
  it('seeds its quote list from initialQuotes', () => {
    const seeded = quote({ id: 5 });
    const { result } = renderHook(() => usePromotions({ entryId: 7, initialQuotes: [seeded] }));
    expect(result.current.quotes).toEqual([seeded]);
  });

  it('defaults to an empty quote list with no initialQuotes', () => {
    const { result } = renderHook(() => usePromotions({ entryId: 7 }));
    expect(result.current.quotes).toEqual([]);
  });

  it('promote calls promotions.create with the entry id and the exact span', async () => {
    mockCreate.mockResolvedValue(quote({ id: 9 }));
    const { result } = renderHook(() => usePromotions({ entryId: 7 }));

    await act(async () => {
      await result.current.promote(2, 19);
    });
    expect(mockCreate).toHaveBeenCalledWith(7, { anchor_start: 2, anchor_end: 19 });
  });

  it('promote appends the returned quote on 201', async () => {
    mockCreate.mockResolvedValue(quote({ id: 9 }));
    const { result } = renderHook(() => usePromotions({ entryId: 7 }));

    await act(async () => {
      await result.current.promote(2, 19);
    });
    expect(result.current.quotes.map((q: PromotedQuote) => q.id)).toEqual([9]);
  });

  it('promote maps an error to a non-blocking hint and does not append a quote', async () => {
    mockCreate.mockRejectedValue(new ApiError(422, 'anchor_out_of_range'));
    const { result } = renderHook(() => usePromotions({ entryId: 7 }));

    await act(async () => {
      await result.current.promote(0, 9999);
    });
    expect(result.current.quotes).toEqual([]);
    expect(result.current.hint).toBeTruthy();
  });

  it('removePromotion optimistically removes the quote', async () => {
    mockRemove.mockResolvedValue(undefined);
    const seeded = quote({ id: 5 });
    const { result } = renderHook(() => usePromotions({ entryId: 7, initialQuotes: [seeded] }));

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
    const { result } = renderHook(() => usePromotions({ entryId: 7, initialQuotes: [seeded] }));

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
    const { result } = renderHook(() => usePromotions({ entryId: 7, initialQuotes: [seeded] }));

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
    const { result } = renderHook(() => usePromotions({ entryId: 7, initialQuotes: [seeded] }));

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
    const { result } = renderHook(() => usePromotions({ entryId: 7 }));

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
    const { result } = renderHook(() => usePromotions({ entryId: 7, initialQuotes: [seeded] }));

    await waitFor(() =>
      expect(result.current.quotes.map((q: PromotedQuote) => q.anchor_text)).toEqual([
        'fresh server copy',
      ]),
    );
  });

  it('never calls promotions.list when entryId is 0 (unsaved entry)', async () => {
    renderHook(() => usePromotions({ entryId: 0 }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('a hydration failure sets a non-blocking hint and leaves quotes empty', async () => {
    mockList.mockRejectedValue(new ApiError(500, 'boom'));
    const { result } = renderHook(() => usePromotions({ entryId: 7 }));

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
    const { result } = renderHook(() => usePromotions({ entryId: 7 }));

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
      ({ id }: { id: number }) => usePromotions({ entryId: id }),
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
    const { result } = renderHook(() => usePromotions({ entryId: 7 }));
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
    const { result } = renderHook(() => usePromotions({ entryId: 7 }));

    await act(async () => {
      await result.current.promote(2, 19);
    });
    expect(result.current.promoting).toBe(false);
  });

  it('promoted is false initially, true after a successful promote, and auto-clears after PROMOTED_NOTICE_MS', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(quote({ id: 9 }));
      const { result } = renderHook(() => usePromotions({ entryId: 7 }));
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
    const { result } = renderHook(() => usePromotions({ entryId: 7 }));
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
    const { result } = renderHook(() => usePromotions({ entryId: 7, initialQuotes: [seeded] }));

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
      const { result, unmount } = renderHook(() => usePromotions({ entryId: 7 }));

      await act(async () => {
        await result.current.promote(2, 19);
      });
      expect(result.current.promoted).toBe(true);
      // The auto-clear timer is armed while the notice is showing.
      expect(jest.getTimerCount()).toBe(1);

      unmount();

      // Unmount must clear that timer. A leaked timer would still be pending
      // here and later fire its state update on the torn-down hook.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
