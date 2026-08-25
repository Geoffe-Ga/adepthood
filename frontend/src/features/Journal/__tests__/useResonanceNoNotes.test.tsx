/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

/**
 * The ``no_notes_message`` field threading through ``useResonance``.
 *
 * A pass that returns zero notes used to be a success the UI rendered as
 * nothing whatsoever — indistinguishable from a dead button, and reported as
 * one. The server now says why, and the hook's job is to carry that sentence
 * through without paraphrasing it: only the server knows which of the several
 * routes to zero notes was taken, so any explanation the client invented would
 * be a guess at a cause it cannot see.
 */
import { note, resonancePayload } from './resonanceTestKit';

import type { CompletionSuggestion, Marginalia, ResonanceResponse } from '@/api';

const NO_NOTES = 'No margin notes came back this time. Keep writing and ask again.';

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

describe('useResonance — no-notes message threading', () => {
  it('is null before any generate pass', () => {
    const flush = jest.fn(async () => 42);
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    expect(result.current.noNotesMessage).toBeNull();
  });

  it('carries the server sentence verbatim after a zero-note pass', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(resonancePayload({ no_notes_message: NO_NOTES }));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.noNotesMessage).toBe(NO_NOTES);
  });

  it('stays null on a pass that produced notes', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValue(resonancePayload({ marginalia: [note({ id: 5 })] }));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.noNotesMessage).toBeNull();
  });

  it('normalises an omitted field to null rather than undefined', async () => {
    const flush = jest.fn(async () => 42);
    const withoutField = { ...resonancePayload() };
    delete (withoutField as { no_notes_message?: unknown }).no_notes_message;
    mockGenerate.mockResolvedValue(withoutField as ResonanceResponse);
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));

    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.noNotesMessage).toBeNull();
  });

  it('clears the stale sentence when a later pass does find something', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValueOnce(resonancePayload({ no_notes_message: NO_NOTES }));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));
    await act(async () => {
      await result.current.requestResonance();
    });
    expect(result.current.noNotesMessage).toBe(NO_NOTES);

    mockGenerate.mockResolvedValueOnce(resonancePayload({ marginalia: [note({ id: 9 })] }));
    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.noNotesMessage).toBeNull();
  });

  it('is not left behind by a failed pass, which has its own error copy', async () => {
    const flush = jest.fn(async () => 42);
    mockGenerate.mockResolvedValueOnce(resonancePayload({ no_notes_message: NO_NOTES }));
    const { result } = renderHook(() => useResonance({ routeEntryId: null, flush }));
    await act(async () => {
      await result.current.requestResonance();
    });

    mockGenerate.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      await result.current.requestResonance();
    });

    expect(result.current.noNotesMessage).toBeNull();
    expect(result.current.error).not.toBeNull();
  });

  it('never comes from the load-on-open path, which runs no pass at all', async () => {
    mockList.mockResolvedValue({ items: [note({ id: 1 })] });
    const flush = jest.fn(async () => 7);
    const { result } = renderHook(() => useResonance({ routeEntryId: 7, flush }));

    await waitFor(() => expect(result.current.marginalia).toHaveLength(1));

    expect(result.current.noNotesMessage).toBeNull();
  });
});
