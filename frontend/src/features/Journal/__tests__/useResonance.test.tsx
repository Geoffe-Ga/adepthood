/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { Marginalia, ResonanceResponse } from '@/api';
import { ApiError } from '@/api';

const mockList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: Marginalia[] }>
>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    resonance: {
      list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
      generate: (...a: unknown[]) =>
        (mockGenerate as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

const { useResonance } = require('../useResonance');

function note(overrides: Partial<Marginalia> = {}): Marginalia {
  return {
    id: 1,
    journal_entry_id: 7,
    kind: 'theme',
    anchor_start: 0,
    anchor_end: 4,
    anchor_text: 'walk',
    note: 'A beginning.',
    essay: null,
    essay_generated_at: null,
    status: 'active',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function resonancePayload(notes: Marginalia[]): ResonanceResponse {
  return {
    marginalia: notes,
    remaining_messages: 48,
    remaining_balance: 0,
    monthly_reset_date: '2026-07-01T00:00:00Z',
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockGenerate.mockReset();
  mockList.mockResolvedValue({ items: [] });
});

describe('useResonance', () => {
  it('loads existing marginalia on mount when the entry has an id', async () => {
    mockList.mockResolvedValue({ items: [note({ id: 1 }), note({ id: 2, anchor_start: 10 })] });
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));
    await waitFor(() => expect(result.current.marginalia).toHaveLength(2));
    expect(mockList).toHaveBeenCalledWith(7);
  });

  it('flushes the save, then generates and stores notes + remaining', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(resonancePayload([note({ id: 5, journal_entry_id: 42 })]));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith(42);
    expect(result.current.marginalia).toHaveLength(1);
    expect(result.current.remaining).toBe(48);
  });

  it('maps a 402 to a friendly error and leaves the page usable', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockRejectedValue(new ApiError(402, 'insufficient_offerings'));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });
    expect(result.current.error).toBeTruthy();
    expect(result.current.error).not.toContain('insufficient_offerings'); // friendly, not raw
    expect(result.current.loading).toBe(false);
  });

  it('guards against concurrent generates (no double-charge on rapid taps)', async () => {
    const flush = jest.fn(async () => 42);
    let resolveGen: (_v: ResonanceResponse) => void = () => {};
    mockGenerate.mockReturnValue(
      new Promise<ResonanceResponse>((resolve) => {
        resolveGen = resolve;
      }),
    );
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      void result.current.requestResonance();
      void result.current.requestResonance(); // second tap while first is in flight
      resolveGen(resonancePayload([note({ id: 9 })]));
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('reports a gentle message when there is nothing to save', async () => {
    const flush = jest.fn(async () => null);
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));
    await act(async () => {
      await result.current.requestResonance();
    });
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
  });
});
