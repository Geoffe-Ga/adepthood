/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import { act, renderHook } from '@testing-library/react-native';
import * as FileSystem from 'expo-file-system';

import type { PickedDocument } from '../pickSeedDocuments';
import {
  MAX_SEED_VAULT_BUSY_WAITS,
  SEED_UPLOAD_LIMIT,
  VAULT_BUSY_FALLBACK_WAIT_MS,
} from '../seedUploadPacing';
import { useSeedRun } from '../useSeedRun';

import { useUploadQueueStore } from '@/store/useUploadQueueStore';

/**
 * #3770: a vault busy with a classify or link pass answers `vault_busy` and a
 * wait. The run waits it out and sends the same document again, the wait is
 * never charged against the upload pace, and the waits are bounded on a
 * counter of their own. Fake timers throughout.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch as unknown as typeof fetch;

const mocked = FileSystem as unknown as { __fileBase64: jest.Mock; __fileSize: jest.Mock };

const ONE_SECOND_MS = 1_000;
/** The wait the issue's example names. */
const CREEK_WAIT_SECONDS = 7;
/** How many calls the vault is busy for in the issue's proof. */
const BUSY_CALLS = SEED_UPLOAD_LIMIT - 1;

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

function answered(body: Record<string, unknown>) {
  return Promise.resolve({
    ok: true,
    status: 202,
    json: () =>
      Promise.resolve({
        destination: 'vault',
        vault_ref: null,
        tags: [],
        corpus_status: null,
        fragment_id: null,
        message: 'ok',
        ...body,
      }),
  });
}

function accepted() {
  return answered({ stored: true, vault_status: 'accepted', retry_after_seconds: null });
}

function busy(retryAfterSeconds: number | null) {
  return answered({
    stored: false,
    vault_status: 'vault_busy',
    retry_after_seconds: retryAfterSeconds,
  });
}

function sentBodies(): { filename: string; upload_run?: string }[] {
  return mockFetch.mock.calls.map((call) => JSON.parse(call[1].body));
}

function statuses(items: readonly { status: string }[]): string[] {
  return items.map((item) => item.status);
}

async function advance(ms = 0): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  useUploadQueueStore.getState().reset();
  mockFetch.mockReset();
  mocked.__fileBase64.mockReset();
  mocked.__fileSize.mockReset();
  mocked.__fileBase64.mockResolvedValue('c2VlZA==');
  mocked.__fileSize.mockReturnValue(64);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a busy vault', () => {
  test('is waited out for as long as it asked, shown as waiting for the vault', async () => {
    mockFetch.mockReturnValueOnce(busy(CREEK_WAIT_SECONDS)).mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments([note('a.md'), note('b.md')]);
    });
    await advance();

    expect(statuses(result.current.items)).toEqual(['vault_waiting', 'queued']);
    expect(result.current.isWaitingOnVault).toBe(true);
    // Not the pace: nothing about this pause is the upload limit.
    expect(result.current.isPaused).toBe(false);

    await advance(CREEK_WAIT_SECONDS * ONE_SECOND_MS - 1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(statuses(result.current.items)).toEqual(['ingested', 'ingested']);
    expect(result.current.isWaitingOnVault).toBe(false);
    const [first, again] = sentBodies();
    expect(again).toEqual(first);
  });

  test('waits the fallback when the answer named no wait', async () => {
    mockFetch.mockReturnValueOnce(busy(null)).mockImplementation(accepted);
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments([note('a.md')]);
    });
    await advance(VAULT_BUSY_FALLBACK_WAIT_MS - 1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(statuses(result.current.items)).toEqual(['ingested']);
  });

  test('is never charged against the pace: 20 documents through 19 busy answers all land', async () => {
    let calls = 0;
    mockFetch.mockImplementation(() => {
      calls += 1;
      return calls <= BUSY_CALLS ? busy(1) : accepted();
    });
    const { result } = renderHook(() => useSeedRun());
    let everPaced = false;

    act(() => {
      void result.current.sendDocuments(notes(SEED_UPLOAD_LIMIT));
    });
    for (let second = 0; second <= BUSY_CALLS; second += 1) {
      await advance(ONE_SECOND_MS);
      everPaced = everPaced || result.current.isPaused;
    }

    expect(statuses(result.current.items).every((status) => status === 'ingested')).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(BUSY_CALLS + SEED_UPLOAD_LIMIT);
    expect(everPaced).toBe(false);
    expect(result.current.isSending).toBe(false);
  });

  test('settles as vault_busy once its own waits are spent, and the run moves on', async () => {
    mockFetch.mockImplementation((_url: string, init: { body: string }) =>
      JSON.parse(init.body).filename === 'a.md' ? busy(1) : accepted(),
    );
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      void result.current.sendDocuments([note('a.md'), note('b.md')]);
    });
    await advance((MAX_SEED_VAULT_BUSY_WAITS + 1) * ONE_SECOND_MS);

    const tries = sentBodies().filter((body) => body.filename === 'a.md');
    expect(tries).toHaveLength(MAX_SEED_VAULT_BUSY_WAITS + 1);
    expect(statuses(result.current.items)).toEqual(['vault_busy', 'ingested']);
    expect(result.current.retryableCount).toBe(1);
  });

  test('stopping during the wait settles it as never sent and leaves no timer', async () => {
    mockFetch.mockReturnValueOnce(busy(30)).mockImplementation(accepted);
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
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('the run id that lets a run share one handshake', () => {
  test('is the same on every document of a queue run and its retry, and new for the next run', async () => {
    // Since #3772 a run is the queue's, not a screen's: it begins when the
    // queue starts from idle, and "Try again" sends its documents under its id.
    mockFetch.mockReturnValueOnce(answered({ stored: false, vault_status: 'degraded' }));
    mockFetch.mockImplementation(accepted);
    const first = renderHook(() => useSeedRun());

    await act(async () => {
      await first.result.current.sendDocuments([note('a.md'), note('b.md')]);
    });
    await act(async () => {
      await first.result.current.retryFailed();
    });
    first.unmount();
    const second = renderHook(() => useSeedRun());
    await act(async () => {
      await second.result.current.sendDocuments([note('c.md')]);
    });

    const ids = sentBodies().map((body) => body.upload_run);
    expect(ids).toHaveLength(4);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/u);
    expect(ids.slice(0, 3)).toEqual([ids[0], ids[0], ids[0]]);
    expect(ids[3]).not.toBe(ids[0]);
  });
});
