/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

/**
 * RED tests for the ``care`` field threading through ``useResonance`` (issue #891).
 *
 * All tests fail until the implementation-specialist adds ``care`` to
 * ``UseResonanceResult``, ``useGeneratePass``, and the hook's return value.
 *
 * The mock surface matches the existing ``useResonance.test.tsx`` exactly so
 * the two files can be merged or colocated without conflict.
 */
import type { CareResponse, CompletionSuggestion, Marginalia, ResonanceResponse } from '@/api';

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

function carePayload(): CareResponse {
  return {
    message: 'What you shared sounds heavy. Here are some people who can help right now.',
    resources: [
      {
        kind: 'hotline',
        name: '988 Suicide & Crisis Lifeline',
        contact: '988',
        what_it_is: 'Free, confidential crisis support — call or text anytime.',
      },
      {
        kind: 'text_line',
        name: 'Crisis Text Line',
        contact: 'Text HOME to 741741',
        what_it_is: 'Text-based crisis counselling, 24/7.',
      },
    ],
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useResonance — care field threading (issue #891)', () => {
  it('exposes care on the hook result when the generate pass returns a care payload', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(resonancePayload({ care: carePayload() }));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    // The hook must expose ``care`` — this fails until the field is added.
    expect(result.current.care).not.toBeNull();
    expect(result.current.care!.message).toBe(
      'What you shared sounds heavy. Here are some people who can help right now.',
    );
    expect(result.current.care!.resources).toHaveLength(2);
    expect(result.current.care!.resources[0]!.kind).toBe('hotline');
  });

  it('leaves care null when the generate pass returns care: null', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(resonancePayload({ care: null }));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.care).toBeNull();
  });

  it('leaves care null when the generate pass omits the care field', async () => {
    const flush = jest.fn(async () => 42);
    // Omit care entirely — the backend's default is None → absent from wire.
    const payloadWithoutCare = { ...resonancePayload() };
    delete (payloadWithoutCare as { care?: unknown }).care;
    mockGenerate.mockResolvedValue(payloadWithoutCare as ResonanceResponse);
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.care == null).toBe(true);
  });

  it('clears stale care when a new requestResonance is started', async () => {
    const flush = jest.fn(async () => 42);

    // First pass: returns care.
    mockGenerate.mockResolvedValueOnce(resonancePayload({ care: carePayload() }));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });
    expect(result.current.care).not.toBeNull(); // care is present after first pass

    // Second pass: returns no care.
    mockGenerate.mockResolvedValueOnce(resonancePayload({ care: null }));
    await act(async () => {
      await result.current.requestResonance();
    });

    // Stale care from the first pass must have been cleared.
    expect(result.current.care).toBeNull();
  });

  it('never populates care from the load-on-open effect (marginalia list does not carry care)', async () => {
    // The load-on-open path calls ``resonance.list`` (returns { items }), which
    // has no care field — so care must stay null on mount regardless of what
    // the marginalia list returns.
    mockList.mockResolvedValue({ items: [note({ id: 1 })] });
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));

    await waitFor(() => expect(result.current.marginalia).toHaveLength(1));

    // care must not have been populated by the load-on-open path.
    expect(result.current.care == null).toBe(true);
  });

  it('still merges marginalia and suggestions alongside care after a generate pass', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(
      resonancePayload({
        marginalia: [note({ id: 5, journal_entry_id: 42 })],
        care: carePayload(),
      }),
    );
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.marginalia).toHaveLength(1);
    expect(result.current.care).not.toBeNull();
  });
});
