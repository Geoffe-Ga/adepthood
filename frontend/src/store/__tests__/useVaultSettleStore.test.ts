/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import * as FileSystem from 'expo-file-system';

import type { PickedDocument } from '@/features/Seed/pickSeedDocuments';
import { resetAllStores } from '@/store/registry';
import { useUploadQueueStore } from '@/store/useUploadQueueStore';
import {
  SETTLE_POLL_INITIAL_MS,
  SETTLED_VISIBLE_MS,
  settleDrainedRun,
  useVaultSettleStore,
} from '@/store/useVaultSettleStore';

/**
 * #3773: when the upload queue drains with something landed, the app asks the
 * server for the one vault pass that run is owed, then follows it quietly until
 * it settles.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch as unknown as typeof fetch;

const mocked = FileSystem as unknown as { __fileBase64: jest.Mock; __fileSize: jest.Mock };

const BATCH = 'ab'.repeat(16);
const COMPLETE_PATH = '/corpus/import/complete';

type RunState = 'queued' | 'running' | 'completed' | 'stopped' | 'failed';

function runBody(state: RunState, stopReason: string | null = null) {
  return {
    run: {
      batch_id: BATCH,
      state,
      stop_reason: stopReason,
      landed: 2,
      started_at: '2026-11-20T09:00:00+00:00',
      finished_at: state === 'queued' || state === 'running' ? null : '2026-11-20T09:05:00+00:00',
    },
  };
}

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
}

function importReply() {
  return json(202, {
    destination: 'vault',
    stored: true,
    vault_status: 'accepted',
    vault_ref: null,
    tags: [],
    corpus_status: null,
    fragment_id: null,
    message: 'ok',
  });
}

/** Answer each settle read in turn with `states`, repeating the last. */
function serve(states: RunState[], { pressStatus = 202 }: { pressStatus?: number } = {}): void {
  let reads = 0;
  mockFetch.mockImplementation((url: string, init: { method?: string }) => {
    if (url.endsWith('/corpus/import')) return importReply();
    if (url.endsWith(COMPLETE_PATH) && init.method === 'POST') {
      return pressStatus >= 400
        ? json(pressStatus, { detail: 'nope' })
        : json(202, runBody('running'));
    }
    const state = states[Math.min(reads, states.length - 1)] ?? 'running';
    reads += 1;
    return json(200, runBody(state, state === 'stopped' ? 'vault_unavailable' : null));
  });
}

function presses(): unknown[] {
  return mockFetch.mock.calls
    .filter(([url, init]) => String(url).endsWith(COMPLETE_PATH) && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body));
}

function phase(): string {
  return useVaultSettleStore.getState().phase;
}

async function flush(ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

function note(path: string): PickedDocument {
  return {
    name: path,
    uri: `file:///vault/${path}`,
    size: 64,
    seedable: true,
    source: { namespace: 'My Vault', relativePath: path },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  resetAllStores();
  mockFetch.mockReset();
  mocked.__fileBase64.mockReset();
  mocked.__fileSize.mockReset();
  mocked.__fileBase64.mockResolvedValue('c2VlZA==');
  mocked.__fileSize.mockReturnValue(64);
});

afterEach(() => {
  resetAllStores();
  jest.useRealTimers();
});

describe('the drain', () => {
  test('presses /corpus/import/complete once for the run that landed something', async () => {
    serve(['completed']);

    await useUploadQueueStore.getState().enqueue([note('a.md'), note('b.md')], 'personal');
    await flush();

    expect(presses()).toHaveLength(1);
    const [press] = presses() as { batch_id: string; landed: number }[];
    expect(press?.landed).toBe(2);
    expect(press?.batch_id).toBe(useUploadQueueStore.getState().lastDrain?.runId);
  });

  test('presses nothing when the run landed nothing', async () => {
    serve(['completed']);

    settleDrainedRun({ runId: BATCH, sent: 3, landed: 0 });
    await flush();

    expect(presses()).toEqual([]);
    expect(phase()).toBe('idle');
  });
});

describe('following the pass', () => {
  test('says it is settling, then settled, then goes quiet', async () => {
    serve(['running', 'completed']);

    settleDrainedRun({ runId: BATCH, sent: 2, landed: 2 });
    await flush();
    expect(presses()).toEqual([{ batch_id: BATCH, landed: 2 }]);
    expect(phase()).toBe('settling');

    await flush(SETTLE_POLL_INITIAL_MS);
    expect(phase()).toBe('settling');
    await flush(SETTLE_POLL_INITIAL_MS * 2);
    expect(phase()).toBe('settled');

    await flush(SETTLED_VISIBLE_MS);
    expect(phase()).toBe('idle');
  });

  test('a vault out of reach is said as deferred, not as a failure', async () => {
    serve(['stopped']);

    settleDrainedRun({ runId: BATCH, sent: 2, landed: 2 });
    await flush(SETTLE_POLL_INITIAL_MS);

    expect(phase()).toBe('deferred');
  });

  test('a press the server refuses leaves nothing on screen', async () => {
    serve([], { pressStatus: 429 });

    settleDrainedRun({ runId: BATCH, sent: 2, landed: 2 });
    await flush(SETTLE_POLL_INITIAL_MS * 10);

    expect(phase()).toBe('idle');
  });

  test('signing out stops following', async () => {
    serve(['running']);

    settleDrainedRun({ runId: BATCH, sent: 2, landed: 2 });
    await flush();
    resetAllStores();
    const callsAtReset = mockFetch.mock.calls.length;
    await flush(SETTLE_POLL_INITIAL_MS * 10);

    expect(phase()).toBe('idle');
    expect(mockFetch.mock.calls.length).toBe(callsAtReset);
  });

  test('a newer drain takes over from the one being followed', async () => {
    serve(['running']);

    settleDrainedRun({ runId: BATCH, sent: 2, landed: 2 });
    await flush();
    settleDrainedRun({ runId: 'cd'.repeat(16), sent: 1, landed: 1 });
    await flush();

    expect(useVaultSettleStore.getState().batchId).toBe('cd'.repeat(16));
  });
});
