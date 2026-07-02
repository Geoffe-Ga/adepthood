/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

/**
 * RED tests for the ``contraction`` field threading through ``useResonance``.
 *
 * All tests fail until the implementation-specialist adds ``contraction`` to
 * ``UseResonanceResult``, ``useGeneratePass``, and the hook's return value.
 *
 * The mock surface matches ``useResonanceCare.test.tsx`` exactly so the two
 * files can be merged or colocated without conflict.
 */
import type {
  CompletionSuggestion,
  ContractionReflection,
  Marginalia,
  ResonanceResponse,
} from '@/api';
import { useContractionSignalStore } from '@/store/useContractionSignalStore';

const mockList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: Marginalia[] }>
>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;
const mockSugList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: CompletionSuggestion[] }>
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
      accept: jest.fn(),
      dismiss: jest.fn(),
    },
  };
});

const { useResonance } = require('../useResonance');

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

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

function contractionPayload(overrides: Partial<ContractionReflection> = {}): ContractionReflection {
  return {
    variant: 'simple_ease_off',
    message: 'Your practice has eased off a little. No rush back.',
    ...overrides,
  };
}

function resonancePayload(overrides: Partial<ResonanceResponse> = {}): ResonanceResponse {
  return {
    marginalia: [],
    suggestions: [],
    remaining_messages: 48,
    remaining_balance: 0,
    monthly_reset_date: '2026-07-01T00:00:00Z',
    care: null,
    contraction: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockList.mockReset();
  mockGenerate.mockReset();
  mockSugList.mockReset();
  mockList.mockResolvedValue({ items: [] });
  mockSugList.mockResolvedValue({ items: [] });
  useContractionSignalStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useResonance — contraction field threading', () => {
  it('is null before any generate pass', () => {
    const flush = jest.fn(async () => 42);
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    expect(result.current.contraction).toBeNull();
  });

  it('never populates contraction from the load-on-open effect (marginalia list carries none)', async () => {
    mockList.mockResolvedValue({ items: [note({ id: 1 })] });
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));

    await waitFor(() => expect(result.current.marginalia).toHaveLength(1));

    expect(result.current.contraction).toBeNull();
  });

  it('exposes contraction on the hook result when a generate pass returns one', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(resonancePayload({ contraction: contractionPayload() }));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.contraction).not.toBeNull();
    expect(result.current.contraction!.variant).toBe('simple_ease_off');
    expect(result.current.contraction!.message).toBe(
      'Your practice has eased off a little. No rush back.',
    );
  });

  it('normalizes undefined contraction (field omitted) to null', async () => {
    const flush = jest.fn(async () => 42);
    const payloadWithoutContraction = { ...resonancePayload() };
    delete (payloadWithoutContraction as { contraction?: unknown }).contraction;
    mockGenerate.mockResolvedValue(payloadWithoutContraction as ResonanceResponse);
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.contraction == null).toBe(true);
  });

  it('clears stale contraction at the start of a subsequent healthy pass', async () => {
    const flush = jest.fn(async () => 42);

    mockGenerate.mockResolvedValueOnce(
      resonancePayload({ contraction: contractionPayload({ variant: 'return_offer' }) }),
    );
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });
    expect(result.current.contraction).not.toBeNull();

    mockGenerate.mockResolvedValueOnce(resonancePayload({ contraction: null }));
    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.contraction).toBeNull();
  });

  it('still merges marginalia and suggestions alongside contraction after a generate pass', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(
      resonancePayload({
        marginalia: [note({ id: 5, journal_entry_id: 42 })],
        contraction: contractionPayload(),
      }),
    );
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.marginalia).toHaveLength(1);
    expect(result.current.contraction).not.toBeNull();
  });
});

describe('useResonance — wiring the contraction signal store', () => {
  it('activates the signal when a generate pass returns a return_offer contraction', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(
      resonancePayload({ contraction: contractionPayload({ variant: 'return_offer' }) }),
    );
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(useContractionSignalStore.getState().active).toBe(true);
  });

  it('leaves the signal inactive when a generate pass returns a simple_ease_off contraction', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(
      resonancePayload({ contraction: contractionPayload({ variant: 'simple_ease_off' }) }),
    );
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(useContractionSignalStore.getState().active).toBe(false);
  });

  it('retracts a previously-active signal when a healthy pass returns no contraction', async () => {
    act(() => {
      useContractionSignalStore.getState().observe(contractionPayload({ variant: 'return_offer' }));
    });
    expect(useContractionSignalStore.getState().active).toBe(true);

    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(resonancePayload({ contraction: null }));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(useContractionSignalStore.getState().active).toBe(false);
  });

  it('leaves the signal unchanged when a generate pass fails', async () => {
    act(() => {
      useContractionSignalStore.getState().observe(contractionPayload({ variant: 'return_offer' }));
    });
    expect(useContractionSignalStore.getState().active).toBe(true);

    const flush = jest.fn(async () => 42);
    mockGenerate.mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(useContractionSignalStore.getState().active).toBe(true);
  });
});
