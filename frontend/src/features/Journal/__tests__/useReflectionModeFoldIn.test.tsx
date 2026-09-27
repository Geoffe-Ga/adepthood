/* eslint-env jest */
// The fold-in's text half and its inclusion mark are two writes. When the mark
// fails, the quote text has already landed, so a retry must mark it without
// splicing it a second time -- and must splice it again only if the writer
// deleted it in the meantime (#2891).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { candidateFromSource } from '../quoteBatch';
import { formatBlockquote, formatSourceDate, sourceAttribution } from '../reflectionCopy';
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

function setup(
  flushResult: () => Promise<number | null> = () => Promise.resolve(42),
  initialBody = 'My week.',
) {
  const bodyRef = { current: initialBody };
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

  it('does not splice a second copy on a retry after a reopen (#2891)', async () => {
    mockSetIncluded.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    const first = setup();
    await first.insert();
    expect(occurrences(first.bodyRef.current, BLOCK)).toBe(1);
    const persisted = first.bodyRef.current;
    first.unmount();

    // The review is reopened: a fresh screen whose body is the one that was saved.
    const reopened = setup(() => Promise.resolve(42), persisted);
    expect(await reopened.insert()).toBe(true);
    expect(occurrences(reopened.bodyRef.current, BLOCK)).toBe(1);
    expect(mockSetIncluded).toHaveBeenLastCalledWith(QUOTE.id, 42);
  });

  it('lands the quote at the caret the body last reported', async () => {
    mockSetIncluded.mockResolvedValue({});
    const { bodyRef, insert, result } = setup();
    act(() => result.current.onBodySelectionChange({ start: 2, end: 2 }));
    await insert();
    expect(bodyRef.current.startsWith(`My\n\n${BLOCK}\n\n`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The batch fold-in (#2885): a whole selection lands as ONE body change and ONE
// entry write, then one inclusion mark per quote. Failures are per quote, and a
// retry re-marks only those -- the body already holds their words.
// ---------------------------------------------------------------------------

const S1: ReflectionSourceItem = { ...SOURCE, id: 11, title: 'S1 title', promoted_quotes: [] };
const S2: ReflectionSourceItem = {
  ...SOURCE,
  id: 12,
  title: null,
  timestamp: '2026-06-03T12:00:00Z',
  promoted_quotes: [],
};
const Q1: PromotedQuoteSummary = { ...QUOTE, id: 1, anchor_text: 'q1 text' };
const Q2: PromotedQuoteSummary = { ...QUOTE, id: 2, anchor_text: 'q2 text' };
const Q3: PromotedQuoteSummary = { ...QUOTE, id: 3, anchor_text: 'q3 text' };
const S2_DATE = formatSourceDate(S2.timestamp);
const THREE = [
  candidateFromSource(Q1, S1),
  candidateFromSource(Q2, S1),
  candidateFromSource(Q3, S2),
];
const BLOCK_Q2 = '> q2 text\n> — S1 title';

type Batch = Awaited<ReturnType<ReturnType<typeof useReflectionMode>['onInsertQuotes']>>;

function batchSetup(flushResult?: () => Promise<number | null>) {
  const ctx = setup(flushResult, 'Before.\n\nAfter.');
  const insertMany = async (candidates: typeof THREE): Promise<Batch> => {
    let outcome: Batch = { included: [], failed: [], skipped: [] };
    await act(async () => {
      outcome = await ctx.result.current.onInsertQuotes(candidates);
    });
    return outcome;
  };
  const retry = async (): Promise<Batch> => {
    let outcome: Batch = { included: [], failed: [], skipped: [] };
    await act(async () => {
      outcome = await ctx.result.current.retryInclusion();
    });
    return outcome;
  };
  return { ...ctx, insertMany, retry };
}

describe('useReflectionMode batch fold-in (#2885)', () => {
  it('injects three quotes with one body change and one flush, in source order at the caret, then marks each included', async () => {
    mockSetIncluded.mockResolvedValue({});
    const { result, onChangeBody, flush, insertMany } = batchSetup();
    act(() => result.current.onBodySelectionChange({ start: 9, end: 9 }));
    const outcome = await insertMany(THREE);
    expect(onChangeBody).toHaveBeenCalledTimes(1);
    expect(onChangeBody).toHaveBeenCalledWith(
      `Before.\n\n> q1 text\n> — S1 title\n\n> q2 text\n> — S1 title\n\n> q3 text\n> — ${S2_DATE}\n\nAfter.`,
    );
    expect(flush).toHaveBeenCalledTimes(1);
    expect(mockSetIncluded.mock.calls).toEqual([
      [1, 42],
      [2, 42],
      [3, 42],
    ]);
    expect(outcome).toEqual({ included: [1, 2, 3], failed: [], skipped: [] });
    expect(result.current.inclusionHint).toBe(false);
    expect(result.current.failedCount).toBe(0);
    expect([...result.current.foldedIds].sort()).toEqual([1, 2, 3]);
  });

  it.each([
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [3, 1, 1, 3],
  ])(
    'for %i quotes: %i body change(s), %i flush(es), %i mark(s)',
    async (n, changes, flushes, marks) => {
      mockSetIncluded.mockResolvedValue({});
      const { onChangeBody, flush, insertMany } = batchSetup();
      await insertMany(THREE.slice(0, n));
      expect(onChangeBody).toHaveBeenCalledTimes(changes);
      expect(flush).toHaveBeenCalledTimes(flushes);
      expect(mockSetIncluded).toHaveBeenCalledTimes(marks);
    },
  );

  it('keeps only the refused quote pending, and a retry re-marks only it without touching the body', async () => {
    mockSetIncluded.mockImplementation((id) =>
      id === 2 ? Promise.reject(new Error('offline')) : Promise.resolve({}),
    );
    const { result, bodyRef, onChangeBody, insertMany, retry } = batchSetup();
    const first = await insertMany(THREE);
    expect(first).toEqual({ included: [1, 3], failed: [2], skipped: [] });
    expect(result.current.inclusionHint).toBe(true);
    expect(result.current.failedCount).toBe(1);
    expect(result.current.foldedIds.has(2)).toBe(false);

    const bodyAfterFirst = bodyRef.current;
    mockSetIncluded.mockReset();
    mockSetIncluded.mockResolvedValue({});
    const second = await retry();
    expect(second).toEqual({ included: [2], failed: [], skipped: [] });
    expect(mockSetIncluded.mock.calls).toEqual([[2, 42]]);
    expect(onChangeBody).toHaveBeenCalledTimes(1);
    expect(bodyRef.current).toBe(bodyAfterFirst);
    expect(occurrences(bodyRef.current, BLOCK_Q2)).toBe(1);
    expect(result.current.inclusionHint).toBe(false);
    expect(result.current.failedCount).toBe(0);
    expect(result.current.foldedIds.has(2)).toBe(true);
  });

  it('a retry with nothing failed does nothing at all', async () => {
    const { onChangeBody, flush, retry } = batchSetup();
    expect(await retry()).toEqual({ included: [], failed: [], skipped: [] });
    expect(onChangeBody).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(mockSetIncluded).not.toHaveBeenCalled();
  });

  it('fails every quote when the entry write fails, and a retry then marks them all', async () => {
    mockSetIncluded.mockResolvedValue({});
    let flushes = 0;
    const { result, insertMany, retry } = batchSetup(() => {
      flushes += 1;
      return Promise.resolve(flushes === 1 ? null : 42);
    });
    expect(await insertMany(THREE)).toEqual({ included: [], failed: [1, 2, 3], skipped: [] });
    expect(mockSetIncluded).not.toHaveBeenCalled();
    expect(result.current.failedCount).toBe(3);
    expect((await retry()).included).toEqual([1, 2, 3]);
  });

  it('a second press while the batch is in flight splices and marks nothing more', async () => {
    const releases: Array<(_v: unknown) => void> = [];
    mockSetIncluded.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const { result, bodyRef, onChangeBody } = batchSetup();
    let first: Promise<Batch> = Promise.resolve({ included: [], failed: [], skipped: [] });
    let second: Promise<Batch> = first;
    await act(async () => {
      first = result.current.onInsertQuotes(THREE);
      await Promise.resolve();
      second = result.current.onInsertQuotes(THREE);
      await Promise.resolve();
    });
    await act(async () => {
      releases.forEach((release) => release({}));
      await first;
    });
    expect(await second).toEqual({ included: [], failed: [], skipped: [1, 2, 3] });
    expect((await first).included).toEqual([1, 2, 3]);
    expect(mockSetIncluded).toHaveBeenCalledTimes(3);
    expect(onChangeBody).toHaveBeenCalledTimes(1);
    expect(occurrences(bodyRef.current, BLOCK_Q2)).toBe(1);
  });

  it('skips only the quote already in flight from a single tap and folds the rest', async () => {
    let release: (_v: unknown) => void = () => {};
    mockSetIncluded.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    mockSetIncluded.mockResolvedValue({});
    const { result } = batchSetup();
    let tap: Promise<boolean> = Promise.resolve(false);
    let batch: Promise<Batch> = Promise.resolve({ included: [], failed: [], skipped: [] });
    await act(async () => {
      tap = result.current.onInsertQuote(Q1, S1);
      await Promise.resolve();
      batch = result.current.onInsertQuotes(THREE);
      await Promise.resolve();
    });
    await act(async () => {
      release({});
      await tap;
      await batch;
    });
    expect(await batch).toEqual({ included: [2, 3], failed: [], skipped: [1] });
    expect(await tap).toBe(true);
  });

  it('writes two identical quotes once and still marks both', async () => {
    mockSetIncluded.mockResolvedValue({});
    const twin = { ...candidateFromSource(Q2, S1), id: 22 };
    const { bodyRef, insertMany } = batchSetup();
    const outcome = await insertMany([candidateFromSource(Q2, S1), twin]);
    expect(occurrences(bodyRef.current, BLOCK_Q2)).toBe(1);
    expect(outcome.included).toEqual([2, 22]);
    expect(mockSetIncluded.mock.calls).toEqual([
      [2, 42],
      [22, 42],
    ]);
  });

  it('holds foldingIn up until the last of the marks settles', async () => {
    const releases: Array<(_v: unknown) => void> = [];
    mockSetIncluded.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const { result } = batchSetup();
    let batch: Promise<Batch> = Promise.resolve({ included: [], failed: [], skipped: [] });
    await act(async () => {
      batch = result.current.onInsertQuotes(THREE);
      await Promise.resolve();
    });
    expect(result.current.foldingIn).toBe(true);
    await act(async () => {
      releases[0]?.({});
      releases[1]?.({});
      await Promise.resolve();
    });
    expect(result.current.foldingIn).toBe(true);
    await act(async () => {
      releases[2]?.({});
      await batch;
    });
    expect(result.current.foldingIn).toBe(false);
  });
});
