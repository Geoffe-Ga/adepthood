/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import * as FileSystem from 'expo-file-system';

import type { PickedDocument } from '@/features/Seed/pickSeedDocuments';
import { SEED_UPLOAD_LIMIT } from '@/features/Seed/seedUploadPacing';
import { resetAllStores } from '@/store/registry';
import {
  onUploadQueueDrained,
  selectUploadQueueRemaining,
  useUploadQueueStore,
  type UploadQueueDrain,
} from '@/store/useUploadQueueStore';

/**
 * #3772: the Seed run lives in an app-level queue, so it outlives the screen,
 * takes more folders while one is going over, keeps one pacer for all of them,
 * and says when it has drained.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch as unknown as typeof fetch;

const mocked = FileSystem as unknown as { __fileBase64: jest.Mock; __fileSize: jest.Mock };

function note(path: string, namespace = 'My Vault'): PickedDocument {
  return {
    name: path.split('/').pop() ?? path,
    uri: `file:///vault/${path}`,
    size: 64,
    seedable: true,
    source: { namespace, relativePath: path },
  };
}

function reply(vaultStatus: string) {
  return Promise.resolve({
    ok: true,
    status: 202,
    json: () =>
      Promise.resolve({
        destination: 'vault',
        stored: vaultStatus === 'accepted',
        vault_status: vaultStatus,
        vault_ref: null,
        tags: [],
        corpus_status: null,
        fragment_id: null,
        message: 'ok',
      }),
  });
}

/** A reply the test holds open, so the queue can be interfered with mid-flight. */
function held(): { reply: Promise<unknown>; release: () => void } {
  let release = (): void => undefined;
  const pending = new Promise<unknown>((resolve) => {
    release = (): void => {
      resolve(reply('accepted'));
    };
  });
  return { reply: pending, release };
}

function sentPaths(): string[] {
  return mockFetch.mock.calls.map((call) => JSON.parse(call[1].body).source_relative_path);
}

function statuses(): string[] {
  const { run } = useUploadQueueStore.getState();
  return run.order.map((id) => run.items[id]?.status ?? 'missing');
}

/** Let every pending promise run. */
async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
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

describe('a batch in the queue', () => {
  test('goes over one at a time and resolves once every document has settled', async () => {
    mockFetch.mockImplementation(() => reply('accepted'));

    await useUploadQueueStore.getState().enqueue([note('a.md'), note('b.md')], 'personal');

    expect(sentPaths()).toEqual(['a.md', 'b.md']);
    expect(statuses()).toEqual(['ingested', 'ingested']);
    expect(useUploadQueueStore.getState().isSending).toBe(false);
    expect(useUploadQueueStore.getState().batches).toEqual([
      { id: 'batch-0', name: 'My Vault', ids: ['seed-0', 'seed-1'] },
    ]);
  });

  test('a batch of only unsendable files settles at once and sends nothing', async () => {
    const unsupported: PickedDocument = { ...note('x.exe'), seedable: false };

    await useUploadQueueStore.getState().enqueue([unsupported], 'personal');

    expect(statuses()).toEqual(['unsupported_format']);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(useUploadQueueStore.getState().isSending).toBe(false);
  });
});

describe('queueing more while a batch is going over', () => {
  test('appends a second batch that runs after the first, never two requests at once', async () => {
    const first = held();
    mockFetch.mockReturnValueOnce(first.reply).mockImplementation(() => reply('accepted'));
    const store = useUploadQueueStore.getState();

    const one = store.enqueue([note('a.md', 'One'), note('b.md', 'One')], 'personal');
    await flush();
    const two = store.enqueue([note('c.md', 'Two')], 'intimate');
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(useUploadQueueStore.getState().batches.map((batch) => batch.name)).toEqual([
      'One',
      'Two',
    ]);
    expect(selectUploadQueueRemaining(useUploadQueueStore.getState())).toBe(3);

    first.release();
    await Promise.all([one, two]);

    expect(sentPaths()).toEqual(['a.md', 'b.md', 'c.md']);
    const tiers = mockFetch.mock.calls.map((call) => JSON.parse(call[1].body).classification);
    expect(tiers).toEqual(['personal', 'personal', 'intimate']);
    expect(selectUploadQueueRemaining(useUploadQueueStore.getState())).toBe(0);
  });

  test('every batch of one queue run shares one run id, and the next run gets its own', async () => {
    const first = held();
    mockFetch.mockReturnValueOnce(first.reply).mockImplementation(() => reply('accepted'));
    const store = useUploadQueueStore.getState();

    const one = store.enqueue([note('a.md')], 'personal');
    await flush();
    const two = store.enqueue([note('b.md')], 'personal');
    first.release();
    await Promise.all([one, two]);
    await store.enqueue([note('c.md')], 'personal');

    const runs = mockFetch.mock.calls.map((call) => JSON.parse(call[1].body).upload_run);
    expect(runs[0]).toMatch(/^[0-9a-f]{32}$/u);
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toMatch(/^[0-9a-f]{32}$/u);
    expect(runs[2]).not.toBe(runs[0]);
  });

  test('one pacer covers every batch, so a second batch cannot exceed the limit', async () => {
    mockFetch.mockImplementation(() => reply('accepted'));
    const store = useUploadQueueStore.getState();
    const many = Array.from({ length: SEED_UPLOAD_LIMIT }, (_unused, index) =>
      note(`n/${index}.md`),
    );

    await store.enqueue(many, 'personal');
    void store.enqueue([note('late.md')], 'personal');
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(SEED_UPLOAD_LIMIT);
    expect(statuses().at(-1)).toBe('waiting');
    store.cancelAll();
    await flush();
  });
});

describe('stopping', () => {
  test('a batch can be stopped on its own while the others go on', async () => {
    const first = held();
    mockFetch.mockReturnValueOnce(first.reply).mockImplementation(() => reply('accepted'));
    const store = useUploadQueueStore.getState();

    const one = store.enqueue([note('a.md', 'One'), note('b.md', 'One')], 'personal');
    await flush();
    const two = store.enqueue([note('c.md', 'Two'), note('d.md', 'Two')], 'personal');
    await flush();
    store.cancelBatch('batch-1');
    first.release();
    await Promise.all([one, two]);

    expect(sentPaths()).toEqual(['a.md', 'b.md']);
    expect(statuses()).toEqual(['ingested', 'ingested', 'cancelled', 'cancelled']);
  });

  test('stopping the batch in flight lets its request finish and moves to the next', async () => {
    const first = held();
    mockFetch.mockReturnValueOnce(first.reply).mockImplementation(() => reply('accepted'));
    const store = useUploadQueueStore.getState();

    const one = store.enqueue([note('a.md', 'One'), note('b.md', 'One')], 'personal');
    await flush();
    const two = store.enqueue([note('c.md', 'Two')], 'personal');
    await flush();
    store.cancelBatch('batch-0');
    first.release();
    await Promise.all([one, two]);

    expect(sentPaths()).toEqual(['a.md', 'c.md']);
    expect(statuses()).toEqual(['ingested', 'cancelled', 'ingested']);
  });

  test('the whole queue can be stopped at once', async () => {
    const first = held();
    mockFetch.mockReturnValueOnce(first.reply).mockImplementation(() => reply('accepted'));
    const store = useUploadQueueStore.getState();

    const one = store.enqueue([note('a.md'), note('b.md')], 'personal');
    await flush();
    const two = store.enqueue([note('c.md')], 'personal');
    await flush();
    store.cancelAll();
    first.release();
    await Promise.all([one, two]);

    expect(sentPaths()).toEqual(['a.md']);
    expect(statuses()).toEqual(['ingested', 'cancelled', 'cancelled']);
  });

  test('stopping a batch that is not in the queue changes nothing', async () => {
    mockFetch.mockImplementation(() => reply('accepted'));
    const store = useUploadQueueStore.getState();
    await store.enqueue([note('a.md')], 'personal');

    store.cancelBatch('batch-9');

    expect(statuses()).toEqual(['ingested']);
  });
});

describe('signing out', () => {
  test('empties the queue, aborts the request in flight, and sends nothing more', async () => {
    let signal: AbortSignal | undefined;
    mockFetch.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    mockFetch.mockImplementation(() => reply('accepted'));
    const drained = jest.fn();
    const stop = onUploadQueueDrained(drained);

    const pending = useUploadQueueStore
      .getState()
      .enqueue([note('a.md'), note('b.md')], 'personal');
    await flush();
    resetAllStores();
    await pending;
    await flush();
    stop();

    expect(signal?.aborted).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(useUploadQueueStore.getState().run.order).toEqual([]);
    expect(useUploadQueueStore.getState().batches).toEqual([]);
    expect(useUploadQueueStore.getState().isSending).toBe(false);
    expect(drained).not.toHaveBeenCalled();
  });

  test('a fresh queue after signing out starts its rows and batches from the beginning', async () => {
    mockFetch.mockImplementation(() => reply('accepted'));
    await useUploadQueueStore.getState().enqueue([note('a.md')], 'personal');

    resetAllStores();
    await useUploadQueueStore.getState().enqueue([note('b.md')], 'personal');

    expect(useUploadQueueStore.getState().batches).toEqual([
      { id: 'batch-0', name: 'My Vault', ids: ['seed-0'] },
    ]);
  });
});

describe('the drained event', () => {
  test('fires once when the queue empties, carrying what landed in that run', async () => {
    const first = held();
    mockFetch
      .mockReturnValueOnce(first.reply)
      .mockReturnValueOnce(reply('degraded'))
      .mockImplementation(() => reply('accepted'));
    const events: UploadQueueDrain[] = [];
    const stop = onUploadQueueDrained((event) => events.push(event));
    const store = useUploadQueueStore.getState();

    const one = store.enqueue([note('a.md'), note('b.md')], 'personal');
    await flush();
    const two = store.enqueue([note('c.md')], 'personal');
    first.release();
    await Promise.all([one, two]);
    stop();

    expect(events).toHaveLength(1);
    expect(events[0]?.landed).toBe(2);
    expect(events[0]?.sent).toBe(3);
    expect(events[0]?.runId).toBe(JSON.parse(mockFetch.mock.calls[0][1].body).upload_run);
    expect(useUploadQueueStore.getState().lastDrain).toEqual(events[0]);
  });

  test('a listener that stopped listening hears nothing', async () => {
    mockFetch.mockImplementation(() => reply('accepted'));
    const drained = jest.fn();
    onUploadQueueDrained(drained)();

    await useUploadQueueStore.getState().enqueue([note('a.md')], 'personal');

    expect(drained).not.toHaveBeenCalled();
  });
});

describe('trying again', () => {
  test('sends only the held documents that did not go over, under the same identity', async () => {
    mockFetch.mockReturnValueOnce(reply('accepted')).mockReturnValueOnce(reply('degraded'));
    mockFetch.mockImplementation(() => reply('accepted'));
    const store = useUploadQueueStore.getState();
    await store.enqueue([note('a.md'), note('b.md')], 'personal');

    expect([...useUploadQueueStore.getState().heldIds]).toEqual(['seed-1']);
    await useUploadQueueStore.getState().retry(['seed-1', 'seed-0']);

    expect(sentPaths()).toEqual(['a.md', 'b.md', 'b.md']);
    const runs = mockFetch.mock.calls.map((call) => JSON.parse(call[1].body).upload_run);
    expect(runs[2]).toBe(runs[1]);
    expect(statuses()).toEqual(['ingested', 'ingested']);
    expect(useUploadQueueStore.getState().heldIds.size).toBe(0);
  });

  test('does nothing while the queue is going over', async () => {
    const first = held();
    mockFetch.mockReturnValueOnce(first.reply).mockImplementation(() => reply('accepted'));
    const store = useUploadQueueStore.getState();
    const pending = store.enqueue([note('a.md')], 'personal');
    await flush();

    await store.retry(['seed-0']);
    first.release();
    await pending;

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
