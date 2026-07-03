/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

/** Specs for the ``care`` field threading through ``useResonance``. */
import { carePayload, note, resonancePayload } from './resonanceTestKit';

import type { CompletionSuggestion, Marginalia, ResonanceResponse } from '@/api';

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

describe('useResonance — care field threading', () => {
  it('exposes care on the hook result when the generate pass returns a care payload', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(resonancePayload({ care: carePayload() }));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    // The hook surfaces ``care`` straight from the generate pass.
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
