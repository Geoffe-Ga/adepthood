/* eslint-env jest */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { resonancePayload } from './resonanceTestKit';

import type {
  CompletionSuggestion,
  Marginalia,
  RelatedEddy,
  RelatedPraxis,
  ResonanceResponse,
} from '@/api';
import { ApiError } from '@/api';

const PRAXIS: RelatedPraxis = {
  title: 'Morning pages',
  praxis_type: 'practice',
  status: 'active',
  excerpt: 'Three quiet pages before the day begins.',
};
const EDDY: RelatedEddy = {
  title: 'Returning to water',
  description: 'Images of rivers and rain gather around this thread.',
  fragment_count: 12,
  formed: '2026-03-04',
};

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
      list: (...args: unknown[]) =>
        (mockList as unknown as (...values: unknown[]) => unknown)(...args),
      generate: (...args: unknown[]) =>
        (mockGenerate as unknown as (...values: unknown[]) => unknown)(...args),
    },
    completionSuggestions: {
      list: (...args: unknown[]) =>
        (mockSugList as unknown as (...values: unknown[]) => unknown)(...args),
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

describe('useResonance — related Creek pages', () => {
  it('stores praxis and eddies returned alongside a resonance pass', async () => {
    mockGenerate.mockResolvedValue(
      resonancePayload({ related_praxis: [PRAXIS], related_eddies: [EDDY] }),
    );
    const { result } = renderHook(() =>
      useResonance({ routeEntryId: null, flush: async () => 42 }),
    );

    await act(async () => result.current.requestResonance());

    expect(result.current.relatedPraxis).toEqual([PRAXIS]);
    expect(result.current.relatedEddies).toEqual([EDDY]);
  });

  it('normalises legacy absent fields and explicit empty arrays to empty state', async () => {
    const legacy = resonancePayload();
    delete legacy.related_praxis;
    delete legacy.related_eddies;
    mockGenerate
      .mockResolvedValueOnce(legacy)
      .mockResolvedValueOnce(resonancePayload({ related_praxis: [], related_eddies: [] }));
    const { result } = renderHook(() =>
      useResonance({ routeEntryId: null, flush: async () => 42 }),
    );

    await act(async () => result.current.requestResonance());
    expect(result.current.relatedPraxis).toEqual([]);
    expect(result.current.relatedEddies).toEqual([]);

    await act(async () => result.current.requestResonance());
    expect(result.current.relatedPraxis).toEqual([]);
    expect(result.current.relatedEddies).toEqual([]);
  });

  it('clears stale related pages before a later pass that fails', async () => {
    mockGenerate
      .mockResolvedValueOnce(resonancePayload({ related_praxis: [PRAXIS], related_eddies: [EDDY] }))
      .mockRejectedValueOnce(new ApiError(500, 'boom'));
    const { result } = renderHook(() =>
      useResonance({ routeEntryId: null, flush: async () => 42 }),
    );

    await act(async () => result.current.requestResonance());
    expect(result.current.relatedPraxis).toHaveLength(1);

    await act(async () => result.current.requestResonance());
    expect(result.current.relatedPraxis).toEqual([]);
    expect(result.current.relatedEddies).toEqual([]);
  });
});
