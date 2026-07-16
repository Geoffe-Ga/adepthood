/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { note, resonancePayload, suggestion } from './resonanceTestKit';

import type {
  AcceptSuggestionResult,
  CompletionSuggestion,
  Marginalia,
  ResonanceResponse,
} from '@/api';
import { ApiError } from '@/api';

const mockList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: Marginalia[] }>
>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;
const mockSugList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: CompletionSuggestion[] }>
>;
const mockAccept = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<AcceptSuggestionResult>
>;
const mockDismiss = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<CompletionSuggestion>
>;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    resonance: {
      list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
      generate: (...a: unknown[]) =>
        (mockGenerate as unknown as (...x: unknown[]) => unknown)(...a),
    },
    completionSuggestions: {
      list: (...a: unknown[]) => (mockSugList as unknown as (...x: unknown[]) => unknown)(...a),
      accept: (...a: unknown[]) => (mockAccept as unknown as (...x: unknown[]) => unknown)(...a),
      dismiss: (...a: unknown[]) => (mockDismiss as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

const { useResonance } = require('../useResonance');

beforeEach(() => {
  mockList.mockReset();
  mockGenerate.mockReset();
  mockSugList.mockReset();
  mockAccept.mockReset();
  mockDismiss.mockReset();
  mockList.mockResolvedValue({ items: [] });
  mockSugList.mockResolvedValue({ items: [] });
});

describe('useResonance', () => {
  it('loads existing marginalia on mount when the entry has an id', async () => {
    mockList.mockResolvedValue({ items: [note({ id: 1 }), note({ id: 2, anchor_start: 10 })] });
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));
    await waitFor(() => expect(result.current.marginalia).toHaveLength(2));
    expect(mockList).toHaveBeenCalledWith(7);
  });

  it('flushes the save, then generates and stores notes', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(
      resonancePayload({ marginalia: [note({ id: 5, journal_entry_id: 42 })] }),
    );
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith(42);
    expect(result.current.marginalia).toHaveLength(1);
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
      resolveGen(resonancePayload({ marginalia: [note({ id: 9 })] }));
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

  it('a slow initial load resolving after a generate pass keeps the generated notes and suggestions', async () => {
    let resolveLoad: (_v: { items: Marginalia[] }) => void = () => {};
    let resolveSugLoad: (_v: { items: CompletionSuggestion[] }) => void = () => {};
    mockList.mockReturnValue(
      new Promise<{ items: Marginalia[] }>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    mockSugList.mockReturnValue(
      new Promise<{ items: CompletionSuggestion[] }>((resolve) => {
        resolveSugLoad = resolve;
      }),
    );
    mockGenerate.mockResolvedValue(
      resonancePayload({
        marginalia: [note({ id: 9, anchor_start: 10 })],
        suggestions: [suggestion({ id: 9, anchor_start: 10 })],
      }),
    );
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    await act(async () => {
      resolveLoad({ items: [note({ id: 1 })] });
      resolveSugLoad({ items: [suggestion({ id: 1 })] });
    });

    expect(result.current.marginalia.map((m: Marginalia) => m.id)).toEqual([1, 9]);
    expect(result.current.suggestions.map((s: CompletionSuggestion) => s.id)).toEqual([1, 9]);
  });

  it('on a slow load resolving after a generate, the generated note wins an id collision', async () => {
    let resolveLoad: (_v: { items: Marginalia[] }) => void = () => {};
    mockList.mockReturnValue(
      new Promise<{ items: Marginalia[] }>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    mockGenerate.mockResolvedValue(
      resonancePayload({ marginalia: [note({ id: 9, note: 'generated copy' })] }),
    );
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    await act(async () => {
      resolveLoad({ items: [note({ id: 9, note: 'stale server copy' })] });
    });

    expect(result.current.marginalia.map((m: Marginalia) => m.note)).toEqual(['generated copy']);
  });

  it('replaces the prior entry notes and suggestions when routeEntryId changes to a different entry', async () => {
    mockList.mockResolvedValueOnce({ items: [note({ id: 1 })] });
    mockSugList.mockResolvedValueOnce({ items: [suggestion({ id: 1 })] });
    const flush = jest.fn(async () => 7);
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useResonance({ routeEntryId: id, flush }),
      { initialProps: { id: 7 } },
    );
    await waitFor(() =>
      expect(result.current.marginalia.map((m: Marginalia) => m.id)).toEqual([1]),
    );

    mockList.mockResolvedValueOnce({
      items: [note({ id: 2, journal_entry_id: 8, anchor_start: 10 })],
    });
    mockSugList.mockResolvedValueOnce({
      items: [suggestion({ id: 2, journal_entry_id: 8, anchor_start: 10 })],
    });
    rerender({ id: 8 });

    await waitFor(() =>
      expect(result.current.marginalia.map((m: Marginalia) => m.id)).toEqual([2]),
    );
    expect(result.current.suggestions.map((s: CompletionSuggestion) => s.id)).toEqual([2]);
  });

  it('a stale privateMessage from a withheld pass is cleared when a later pass errors', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValueOnce(
      resonancePayload({ private_message: 'Intimate entry - resonance paused.' }),
    );
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });
    expect(result.current.privateMessage).toBe('Intimate entry - resonance paused.');

    mockGenerate.mockRejectedValueOnce(new ApiError(500, 'boom'));
    await act(async () => {
      await result.current.requestResonance();
    });
    expect(result.current.privateMessage).toBeNull();
    expect(result.current.error).toBeTruthy();
  });
});

describe('useResonance — suggestions', () => {
  it('loads existing suggestions on mount when the entry has an id', async () => {
    mockSugList.mockResolvedValue({ items: [suggestion({ id: 1 }), suggestion({ id: 2 })] });
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    expect(mockSugList).toHaveBeenCalledWith(7);
  });

  it('merges suggestions from a generate pass, deduped + sorted by anchor', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(
      resonancePayload({
        suggestions: [
          suggestion({ id: 2, anchor_start: 20 }),
          suggestion({ id: 1, anchor_start: 0 }),
        ],
      }),
    );
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));
    await act(async () => {
      await result.current.requestResonance();
    });
    expect(result.current.suggestions.map((s: CompletionSuggestion) => s.id)).toEqual([1, 2]);
  });

  it('accept replaces the row with the accepted one and exposes the check-in', async () => {
    mockSugList.mockResolvedValue({ items: [suggestion({ id: 1, status: 'pending' })] });
    mockAccept.mockResolvedValue({
      suggestion: suggestion({ id: 1, status: 'accepted', accepted_at: '2026-06-02T00:00:00Z' }),
      check_in: { streak: 4, milestones: [{ threshold: 3 }], reason_code: 'streak_incremented' },
    });
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));

    await act(async () => {
      await result.current.acceptSuggestion(1);
    });
    expect(mockAccept).toHaveBeenCalledWith(1);
    expect(result.current.suggestions[0]!.status).toBe('accepted');
    expect(result.current.acceptedCheckIns[1]?.streak).toBe(4);
  });

  it('accept leaves the row pending and surfaces a friendly error on failure', async () => {
    mockSugList.mockResolvedValue({ items: [suggestion({ id: 1, status: 'pending' })] });
    mockAccept.mockRejectedValue(new ApiError(409, 'already_dismissed'));
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));

    await act(async () => {
      await result.current.acceptSuggestion(1);
    });
    expect(result.current.suggestions[0]!.status).toBe('pending');
    expect(result.current.error).toBeTruthy();
  });

  it('dismiss optimistically removes the row', async () => {
    mockSugList.mockResolvedValue({ items: [suggestion({ id: 1 }), suggestion({ id: 2 })] });
    mockDismiss.mockResolvedValue(suggestion({ id: 1, status: 'dismissed' }));
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));

    await act(async () => {
      await result.current.dismissSuggestion(1);
    });
    expect(result.current.suggestions.map((s: CompletionSuggestion) => s.id)).toEqual([2]);
  });

  it('dismiss reverts the optimistic removal on error', async () => {
    mockSugList.mockResolvedValue({ items: [suggestion({ id: 1 }), suggestion({ id: 2 })] });
    mockDismiss.mockRejectedValue(new ApiError(500, 'boom'));
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));

    await act(async () => {
      await result.current.dismissSuggestion(1);
    });
    expect(result.current.suggestions.map((s: CompletionSuggestion) => s.id)).toEqual([1, 2]); // reverted
    expect(result.current.error).toBeTruthy();
  });

  it('a suggestion generated mid-dismiss survives a failed dismiss', async () => {
    mockSugList.mockResolvedValue({ items: [suggestion({ id: 1 })] });
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));

    let rejectDismiss: (_e: unknown) => void = () => {};
    mockDismiss.mockReturnValue(
      new Promise<CompletionSuggestion>((_resolve, reject) => {
        rejectDismiss = reject;
      }),
    );
    let dismissPromise: Promise<void> = Promise.resolve();
    act(() => {
      dismissPromise = result.current.dismissSuggestion(1);
    });
    expect(result.current.suggestions).toHaveLength(0);

    mockGenerate.mockResolvedValue(
      resonancePayload({ suggestions: [suggestion({ id: 2, anchor_start: 20 })] }),
    );
    await act(async () => {
      await result.current.requestResonance();
    });
    expect(result.current.suggestions.map((s: CompletionSuggestion) => s.id)).toContain(2);

    await act(async () => {
      rejectDismiss(new ApiError(500, 'boom'));
      await dismissPromise;
    });
    expect(result.current.suggestions.map((s: CompletionSuggestion) => s.id)).toEqual([1, 2]);
    expect(result.current.error).toBeTruthy();
  });
});
