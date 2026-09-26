/* eslint-env jest */
// The fold-in's text half and its inclusion mark are two writes. When the mark
// fails, the quote text has already landed, so a retry must mark it without
// splicing it a second time -- and must splice it again only if the writer
// deleted it in the meantime (#2891).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { formatBlockquote, sourceAttribution } from '../reflectionCopy';
import { useReflectionMode } from '../useReflectionMode';

import type { PromotedQuoteSummary, ReflectionSourceItem } from '@/api';

const mockSetIncluded = jest.fn<(_id: number, _entryId: number | null) => Promise<unknown>>();

jest.mock('@/api', () => ({
  promotions: {
    setIncluded: (...a: [number, number | null]) => mockSetIncluded(...a),
    create: jest.fn(),
  },
  reflections: {
    sources: () => Promise.resolve({ items: [] }),
  },
}));

const QUOTE: PromotedQuoteSummary = {
  id: 90,
  anchor_start: 2,
  anchor_end: 19,
  anchor_text: 'went for a daily walk',
  pending: true,
};

const SOURCE: ReflectionSourceItem = {
  kind: 'entry',
  id: 1,
  title: 'Runs',
  timestamp: '2026-06-01T00:00:00Z',
  body: 'I went for a daily walk to the river.',
  reflection_level: null,
  promoted_quotes: [QUOTE],
};

const BLOCK = formatBlockquote(QUOTE.anchor_text, sourceAttribution(SOURCE));

/** How many times ``needle`` occurs in ``haystack``. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function setup(flushResult: () => Promise<number | null> = () => Promise.resolve(42)) {
  const bodyRef = { current: 'My week.' };
  const onChangeBody = jest.fn((next: string) => {
    bodyRef.current = next;
  });
  const flush = jest.fn(flushResult);
  const hook = renderHook(() =>
    useReflectionMode({
      reflectionLevel: 'week',
      reflectionScopeKey: '2026-W23',
      bodyRef,
      onChangeBody,
      flush,
    }),
  );
  const insert = async (): Promise<boolean> => {
    let result = false;
    await act(async () => {
      result = await hook.result.current.onInsertQuote(QUOTE, SOURCE);
    });
    return result;
  };
  return { ...hook, bodyRef, onChangeBody, flush, insert };
}

beforeEach(() => {
  mockSetIncluded.mockReset();
});

describe('useReflectionMode fold-in -- a failed inclusion mark (#2891)', () => {
  it('leaves the quote in the body exactly once and raises the hint', async () => {
    mockSetIncluded.mockRejectedValueOnce(new Error('offline'));
    const { bodyRef, insert, result } = setup();
    expect(await insert()).toBe(false);
    expect(occurrences(bodyRef.current, BLOCK)).toBe(1);
    expect(result.current.inclusionHint).toBe(true);
  });

  it('a retry that succeeds marks the quote without inserting it again', async () => {
    mockSetIncluded.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    const { bodyRef, insert, result } = setup();
    await insert();
    expect(await insert()).toBe(true);
    expect(occurrences(bodyRef.current, BLOCK)).toBe(1);
    expect(mockSetIncluded).toHaveBeenLastCalledWith(QUOTE.id, 42);
    expect(result.current.inclusionHint).toBe(false);
  });

  it('a retry that fails again keeps one copy and reports the quote still pending', async () => {
    mockSetIncluded.mockRejectedValue(new Error('offline'));
    const { bodyRef, insert } = setup();
    await insert();
    expect(await insert()).toBe(false);
    expect(await insert()).toBe(false);
    expect(occurrences(bodyRef.current, BLOCK)).toBe(1);
  });

  it('re-inserts the quote once when the writer deleted it before retrying', async () => {
    mockSetIncluded.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    const { bodyRef, insert } = setup();
    await insert();
    bodyRef.current = 'My week, rewritten.';
    expect(await insert()).toBe(true);
    expect(occurrences(bodyRef.current, BLOCK)).toBe(1);
  });

  it('keeps one copy when the entry write failed and the fold-in is retried', async () => {
    mockSetIncluded.mockResolvedValue({});
    let flushes = 0;
    const { bodyRef, insert } = setup(() => {
      flushes += 1;
      return Promise.resolve(flushes === 1 ? null : 42);
    });
    expect(await insert()).toBe(false);
    expect(await insert()).toBe(true);
    expect(occurrences(bodyRef.current, BLOCK)).toBe(1);
  });

  it('a second tap while the first is in flight marks once and inserts once', async () => {
    let release: (_value: unknown) => void = () => {};
    mockSetIncluded.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { bodyRef, result } = setup();
    let first: Promise<boolean> = Promise.resolve(false);
    let second: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      first = result.current.onInsertQuote(QUOTE, SOURCE);
      await Promise.resolve();
      second = result.current.onInsertQuote(QUOTE, SOURCE);
      await Promise.resolve();
    });
    await act(async () => {
      release({});
      await first;
    });
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(mockSetIncluded).toHaveBeenCalledTimes(1);
    expect(occurrences(bodyRef.current, BLOCK)).toBe(1);
  });

  it('after a successful mark, folding the same quote in again is a fresh insertion', async () => {
    mockSetIncluded.mockResolvedValue({});
    const { bodyRef, insert } = setup();
    await insert();
    await insert();
    expect(occurrences(bodyRef.current, BLOCK)).toBe(2);
  });

  it('lands the quote at the caret the body last reported', async () => {
    mockSetIncluded.mockResolvedValue({});
    const { bodyRef, insert, result } = setup();
    act(() => result.current.onBodySelectionChange({ start: 2, end: 2 }));
    await insert();
    expect(bodyRef.current.startsWith(`My\n\n${BLOCK}\n\n`)).toBe(true);
  });
});
