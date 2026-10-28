/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import { act, renderHook } from '@testing-library/react-native';
import * as FileSystem from 'expo-file-system';

import type { PickedDocument } from '../pickSeedDocuments';
import {
  MAX_SEED_RATE_LIMIT_WAITS,
  SEED_UPLOAD_LIMIT,
  SEED_UPLOAD_PACING_MARGIN_MS,
  SEED_UPLOAD_WINDOW_MS,
} from '../seedUploadPacing';
import { MAX_SEED_RETRIES_PER_DOCUMENT, useSeedRun } from '../useSeedRun';

/**
 * #3556: a folder import paced under the upload limit, a 429 waited out rather
 * than settled as a failure, and the ones that did not go over offered again.
 * Fake timers throughout, so every wait is the test's to move.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch as unknown as typeof fetch;

const mocked = FileSystem as unknown as { __fileBase64: jest.Mock; __fileSize: jest.Mock };

/** A folder note, as the folder review hands it to the run. */
function note(path: string): PickedDocument {
  const name = path.split('/').pop() ?? path;
  return {
    name,
    uri: `file:///vault/${path}`,
    size: 64,
    seedable: true,
    source: { namespace: 'My Vault', relativePath: path },
  };
}

function notes(count: number): PickedDocument[] {
  return Array.from({ length: count }, (_unused, index) => note(`Notes/${index}.md`));
}

function accepted() {
  return Promise.resolve({
    ok: true,
    status: 202,
    json: () =>
      Promise.resolve({
        destination: 'vault',
        stored: true,
        vault_status: 'accepted',
        vault_ref: null,
        tags: [],
        corpus_status: null,
        fragment_id: null,
        message: 'ok',
      }),
  });
}

function refused(status: number, detail: string, retryAfter: string | null = null) {
  return Promise.resolve({
    ok: false,
    status,
    headers: new Headers(retryAfter === null ? {} : { 'Retry-After': retryAfter }),
    json: () => Promise.resolve({ detail }),
  });
}

function rateLimited(retryAfter: string | null) {
  return refused(429, 'rate_limit_exceeded', retryAfter);
}

function sentBodies(): {
  filename: string;
  source_relative_path?: string;
  classification: string;
}[] {
  return mockFetch.mock.calls.map((call) => JSON.parse(call[1].body));
}

function statuses(items: readonly { status: string }[]): string[] {
  return items.map((item) => item.status);
}

/** Let every pending promise and any timer due within `ms` run. */
async function advance(ms = 0): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFetch.mockReset();
  mocked.__fileBase64.mockReset();
  mocked.__fileSize.mockReset();
  mocked.__fileBase64.mockResolvedValue('c2VlZA==');
  mocked.__fileSize.mockReturnValue(64);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a folder larger than the upload limit', () => {
  test('sends a whole window at once, then paces the rest instead of failing them', async () => {
    mockFetch.mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());
    const extra = 5;

    act(() => {
      void result.current.sendDocuments(notes(SEED_UPLOAD_LIMIT + extra));
    });
    await advance();

    expect(mockFetch).toHaveBeenCalledTimes(SEED_UPLOAD_LIMIT);
    expect(result.current.items[SEED_UPLOAD_LIMIT]?.status).toBe('waiting');
    expect(result.current.isPaused).toBe(true);
    expect(result.current.isSending).toBe(true);

    await advance(SEED_UPLOAD_WINDOW_MS + SEED_UPLOAD_PACING_MARGIN_MS);

    expect(mockFetch).toHaveBeenCalledTimes(SEED_UPLOAD_LIMIT + extra);
    expect(statuses(result.current.items).every((status) => status === 'ingested')).toBe(true);
    expect(result.current.isPaused).toBe(false);
    expect(result.current.isSending).toBe(false);
  });

  test('paces one at a time: never two requests open, even after a pause', async () => {
    let open = 0;
    let mostOpen = 0;
    mockFetch.mockImplementation(async () => {
      open += 1;
      mostOpen = Math.max(mostOpen, open);
      await Promise.resolve();
      open -= 1;
      return accepted();
    });
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments(notes(SEED_UPLOAD_LIMIT + 2));
    });
    await advance(SEED_UPLOAD_WINDOW_MS + SEED_UPLOAD_PACING_MARGIN_MS);

    expect(mockFetch).toHaveBeenCalledTimes(SEED_UPLOAD_LIMIT + 2);
    expect(mostOpen).toBe(1);
  });

  test('stopping during a pace sends nothing more and leaves no timer behind', async () => {
    mockFetch.mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments(notes(SEED_UPLOAD_LIMIT + 3));
    });
    await advance();
    act(() => {
      result.current.cancel();
    });
    await advance(SEED_UPLOAD_WINDOW_MS * 2);

    expect(mockFetch).toHaveBeenCalledTimes(SEED_UPLOAD_LIMIT);
    expect(statuses(result.current.items).slice(SEED_UPLOAD_LIMIT)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(result.current.isSending).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('leaving the screen during a pace sends nothing more', async () => {
    mockFetch.mockImplementation(accepted);
    const { result, unmount } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments(notes(SEED_UPLOAD_LIMIT + 3));
    });
    await advance();
    unmount();
    await advance(SEED_UPLOAD_WINDOW_MS * 2);

    expect(mockFetch).toHaveBeenCalledTimes(SEED_UPLOAD_LIMIT);
  });
});

describe('a 429 that arrives anyway', () => {
  test('waits exactly as long as Retry-After asks, then sends the same document again', async () => {
    mockFetch.mockReturnValueOnce(rateLimited('7')).mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments([note('Work/Index.md'), note('Home/Index.md')]);
    });
    await advance();

    expect(statuses(result.current.items)).toEqual(['waiting', 'queued']);
    expect(result.current.isPaused).toBe(true);

    await advance(6_999);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await advance(1);

    expect(statuses(result.current.items)).toEqual(['ingested', 'ingested']);
    const [first, again, next] = sentBodies();
    expect(again).toEqual(first);
    expect(next?.source_relative_path).toBe('Home/Index.md');
  });

  test('waits one whole window when the server named no wait', async () => {
    mockFetch.mockReturnValueOnce(rateLimited(null)).mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments([note('a.md')]);
    });
    await advance(SEED_UPLOAD_WINDOW_MS - 1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await advance(1);

    expect(statuses(result.current.items)).toEqual(['ingested']);
  });

  test('settles as rate_limited once its waits are spent, and the run moves on', async () => {
    mockFetch.mockImplementation((_url: string, init: { body: string }) =>
      JSON.parse(init.body).filename === 'a.md' ? rateLimited('1') : accepted(),
    );
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments([note('a.md'), note('b.md')]);
    });
    await advance(MAX_SEED_RATE_LIMIT_WAITS * 1_000);

    const tries = sentBodies().filter((body) => body.filename === 'a.md');
    expect(tries).toHaveLength(MAX_SEED_RATE_LIMIT_WAITS + 1);
    expect(statuses(result.current.items)).toEqual(['rate_limited', 'ingested']);
  });

  test('does not sit through a wait longer than its cap', async () => {
    mockFetch.mockReturnValueOnce(rateLimited('3600')).mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments([note('a.md')]);
    });
    await advance();

    expect(statuses(result.current.items)).toEqual(['rate_limited']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.isSending).toBe(false);
  });

  test('stopping during the wait settles it as never sent, and sends nothing more', async () => {
    mockFetch.mockReturnValueOnce(rateLimited('30')).mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments([note('a.md'), note('b.md')]);
    });
    await advance();
    act(() => {
      result.current.cancel();
    });
    await advance(60_000);

    expect(statuses(result.current.items)).toEqual(['cancelled', 'cancelled']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.isSending).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('trying the ones that did not go over again', () => {
  test('sends only those, with the same identity, and never re-sends a success', async () => {
    mockFetch
      .mockReturnValueOnce(accepted())
      .mockReturnValueOnce(refused(422, 'invalid_document'))
      .mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.sendDocuments([note('Work/Index.md'), note('Home/Index.md')]);
    });
    expect(statuses(result.current.items)).toEqual(['ingested', 'failed']);
    expect(result.current.retryableCount).toBe(1);

    await act(async () => {
      await result.current.retryFailed();
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const bodies = sentBodies();
    expect(bodies[2]).toEqual(bodies[1]);
    expect(statuses(result.current.items)).toEqual(['ingested', 'ingested']);
    expect(result.current.retryableCount).toBe(0);
  });

  test('keeps the privacy level the document first went at, whatever is chosen since', async () => {
    mockFetch.mockReturnValueOnce(refused(422, 'invalid_document')).mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.sendDocuments([note('a.md')]);
    });
    act(() => {
      result.current.chooseClassification('intimate');
    });
    await act(async () => {
      await result.current.retryFailed();
    });

    expect(sentBodies().map((body) => body.classification)).toEqual(['personal', 'personal']);
  });

  test('is bounded: a document that keeps failing stops being offered', async () => {
    mockFetch.mockImplementation(() => refused(422, 'invalid_document'));
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.sendDocuments([note('a.md')]);
    });
    for (let retry = 0; retry < MAX_SEED_RETRIES_PER_DOCUMENT; retry += 1) {
      expect(result.current.retryableCount).toBe(1);
      await act(async () => {
        await result.current.retryFailed();
      });
    }

    expect(result.current.retryableCount).toBe(0);
    await act(async () => {
      await result.current.retryFailed();
    });
    expect(mockFetch).toHaveBeenCalledTimes(MAX_SEED_RETRIES_PER_DOCUMENT + 1);
  });

  test('offers nothing for a document stopped by the person or refused for good', async () => {
    mockFetch.mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.sendDocuments([
        { ...note('a.exe'), name: 'a.exe', seedable: false },
        note('b.md'),
      ]);
    });

    expect(result.current.retryableCount).toBe(0);
  });

  test('a retry is paced like any other send', async () => {
    mockFetch.mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());
    const all = notes(SEED_UPLOAD_LIMIT);
    mockFetch.mockReturnValueOnce(refused(422, 'invalid_document'));

    act(() => {
      void result.current.sendDocuments(all);
    });
    await advance();
    expect(result.current.retryableCount).toBe(1);

    act(() => {
      void result.current.retryFailed();
    });
    await advance();
    expect(mockFetch).toHaveBeenCalledTimes(SEED_UPLOAD_LIMIT);
    expect(result.current.items[0]?.status).toBe('waiting');

    await advance(SEED_UPLOAD_WINDOW_MS + SEED_UPLOAD_PACING_MARGIN_MS);
    expect(mockFetch).toHaveBeenCalledTimes(SEED_UPLOAD_LIMIT + 1);
    expect(result.current.items[0]?.status).toBe('ingested');
  });
});
