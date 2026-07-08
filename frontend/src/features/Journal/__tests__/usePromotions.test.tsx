/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { PromotedQuote } from '@/api';
import { ApiError } from '@/api';

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

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    promotions: {
      create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
      remove: (...a: unknown[]) => (mockRemove as unknown as (...x: unknown[]) => unknown)(...a),
      setIncluded: jest.fn(),
    },
  };
});

// RED: `usePromotions` does not exist yet -- this `require` fails with
// "Cannot find module" until the implementation-specialist adds the hook.
const { usePromotions } = require('../usePromotions');

beforeEach(() => {
  mockCreate.mockReset();
  mockRemove.mockReset();
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
});
