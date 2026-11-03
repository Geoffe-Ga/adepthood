// The composer's half of "From your reading" (#3659): the Sources feed's
// Course and letter quotes are held beside its items, cleared with them when
// the scope changes, and folded through the SAME path as an entry's quote --
// spliced at the caret with their own attribution, then marked included with
// ``promotions.setIncluded`` on the review.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { QUOTE_GONE_DETAIL, QUOTE_GONE_STATUS } from '../inclusionMark';
import { useReflectionMode } from '../useReflectionMode';

import { ApiError } from '@/api';
import type { ReadingQuoteItem, ReflectionSourcesResponse } from '@/api';

const mockSetIncluded = jest.fn<(_id: number, _entryId: number | null) => Promise<unknown>>();
const mockSources = jest.fn<() => Promise<Partial<ReflectionSourcesResponse>>>();

jest.mock('@/api', () => ({
  ApiError: (jest.requireActual('@/api') as { ApiError: typeof ApiError }).ApiError,
  promotions: {
    setIncluded: (...a: [number, number | null]) => mockSetIncluded(...a),
    create: jest.fn(),
  },
  reflections: {
    sources: () => mockSources(),
  },
}));

const CHAPTER: ReadingQuoteItem = {
  id: 71,
  source_kind: 'course',
  source_title: 'Beige 1',
  anchor_start: 3,
  anchor_end: 14,
  anchor_text: 'warm hearth',
  pending: true,
  created_at: '2026-06-02T08:00:00Z',
};
const LETTER: ReadingQuoteItem = {
  ...CHAPTER,
  id: 72,
  source_kind: 'letter',
  source_title: 'Rain',
  anchor_text: 'be gentle',
};

function setup(scopeKey = 'c1:w1') {
  const bodyRef = { current: 'My week.' };
  const onChangeBody = jest.fn((next: string) => {
    bodyRef.current = next;
  });
  const flush = jest.fn(() => Promise.resolve(42));
  const hook = renderHook(
    ({ key }: { key: string }) =>
      useReflectionMode({
        reflectionLevel: 'week',
        reflectionScopeKey: key,
        bodyRef,
        onChangeBody,
        flush,
      }),
    { initialProps: { key: scopeKey } },
  );
  return { ...hook, bodyRef };
}

beforeEach(() => {
  mockSetIncluded.mockReset();
  mockSetIncluded.mockResolvedValue({});
  mockSources.mockReset();
  mockSources.mockResolvedValue({ items: [], reading_quotes: [CHAPTER, LETTER] });
});

describe('useReflectionMode -- quotes from the reading (#3659)', () => {
  it('hands the panel the reading quotes the feed carried', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.readingQuotes).toEqual([CHAPTER, LETTER]));
  });

  it('reads a feed with no reading quotes as none', async () => {
    mockSources.mockResolvedValue({ items: [] });
    const { result } = setup();
    await waitFor(() => expect(result.current.feedStatus).toBe('ready'));
    expect(result.current.readingQuotes).toEqual([]);
  });

  it('clears them the instant the scope changes', async () => {
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.readingQuotes).toHaveLength(2));
    mockSources.mockReturnValue(new Promise(() => {}));

    rerender({ key: 'c1:w2' });

    expect(result.current.readingQuotes).toEqual([]);
  });

  it('folds a chapter quote in with its attribution, and marks it on the review', async () => {
    const { result, bodyRef } = setup();
    await waitFor(() => expect(result.current.readingQuotes).toHaveLength(2));

    let marked: boolean | undefined;
    await act(async () => {
      marked = await result.current.onInsertReadingQuote(CHAPTER);
    });

    expect(marked).toBe(true);
    expect(bodyRef.current).toBe('My week.\n\n> warm hearth\n> — From “Beige 1”\n\n');
    expect(mockSetIncluded).toHaveBeenCalledWith(71, 42);
    expect(result.current.foldedIds.has(71)).toBe(true);
  });

  it('attributes a letter quote to a letter', async () => {
    const { result, bodyRef } = setup();
    await waitFor(() => expect(result.current.readingQuotes).toHaveLength(2));

    await act(async () => {
      await result.current.onInsertReadingQuote(LETTER);
    });

    expect(bodyRef.current).toContain('> be gentle\n> — From a letter');
  });

  it('reports a refused mark, and keeps the quote for a retry', async () => {
    mockSetIncluded.mockRejectedValueOnce(new Error('offline'));
    const { result } = setup();
    await waitFor(() => expect(result.current.readingQuotes).toHaveLength(2));

    let marked: boolean | undefined;
    await act(async () => {
      marked = await result.current.onInsertReadingQuote(CHAPTER);
    });

    expect(marked).toBe(false);
    expect(result.current.failedCount).toBe(1);
  });

  it('retires a reading quote the server says is gone from the panel', async () => {
    mockSetIncluded.mockRejectedValueOnce(new ApiError(QUOTE_GONE_STATUS, QUOTE_GONE_DETAIL));
    const { result } = setup();
    await waitFor(() => expect(result.current.readingQuotes).toHaveLength(2));

    await act(async () => {
      await result.current.onInsertReadingQuote(CHAPTER);
    });

    expect(result.current.readingQuotes).toEqual([LETTER]);
  });
});
