import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { journal, habits, setTokenGetter, setOnUnauthorized } from '@/api';
import { releaseUris } from '@/features/Journal/capture/cleanupPageFiles';
import { getJsonArray } from '@/storage/jsonStore';

const mockDelete = jest.fn<() => void>();
jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///cache/' } },
  File: class {
    exists = true;
    delete() {
      mockDelete();
    }
  },
}));
jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const CANARIES = [
  'private brief',
  'private context '.repeat(100),
  '隐私只在纸上',
  'private\nnote',
  '秘密\u202Eprivate',
  'private 🪷 note',
];
const mockFetch = jest.fn<typeof fetch>();
let logs: unknown[][];
beforeEach(() => {
  logs = [];
  for (const level of ['warn', 'error', 'info', 'log', 'debug'] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
  }
  global.fetch = mockFetch;
  mockFetch.mockReset();
  mockDelete.mockReset();
  setTokenGetter(null);
  setOnUnauthorized(null);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Include non-enumerable Error fields; JSON.stringify(Error) hides the actual leak. */
function allText(value: unknown, seen = new Set<object>()): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .map((field) => ('value' in field ? allText(field.value, seen) : ''))
    .join(' ');
}
function expectAbsent(canary: string) {
  expect(allText(logs)).not.toContain(canary);
}
function response(data: unknown, status: number): Response {
  return { ok: status < 400, status, json: async () => data } as Response;
}

describe('private values at client failure sinks (#3210)', () => {
  it.each(CANARIES)(
    'keeps transient storage errors and keys out of diagnostics (%s)',
    async (canary) => {
      const error = new Error(canary, { cause: new Error(canary) });
      jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(error);
      const remove = jest.spyOn(AsyncStorage, 'removeItem');
      await expect(getJsonArray(`private-key-${canary}`)).resolves.toBeNull();
      expect(remove).not.toHaveBeenCalled();
      expectAbsent(canary);
      expect(logs).toContainEqual(['storage_read_failed']);
    },
  );

  it.each(CANARIES)('keeps selected filenames out of best-effort cleanup (%s)', async (canary) => {
    mockDelete.mockImplementation(() => {
      throw new Error(canary);
    });
    await expect(
      releaseUris([`file:///cache/${canary}.jpg`, 'file:///cache/second.jpg']),
    ).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledTimes(2);
    expectAbsent(canary);
    expect(logs).toEqual([['capture_cleanup_failed'], ['capture_cleanup_failed']]);
  });

  it.each(CANARIES)(
    'keeps malformed response fields and Zod issues out of validation logs (%s)',
    async (canary) => {
      mockFetch.mockResolvedValue(response([{ name: canary, streak: canary }], 200));
      await expect(habits.list()).rejects.toMatchObject({ name: 'ApiValidationError' });
      expectAbsent(canary);
      expect(logs).toContainEqual([
        'api_response_invalid',
        expect.objectContaining({ route: '/habits/', status: 200, issueCount: expect.any(Number) }),
      ]);
    },
  );

  it.each(CANARIES)(
    'omits private search queries and malicious request IDs on server failure (%s)',
    async (canary) => {
      jest.useFakeTimers();
      mockFetch.mockResolvedValue(response({ error: 'internal_error', request_id: canary }, 500));
      const read = journal.list({ search: canary });
      const failure = read.catch((error: unknown) => error);
      await jest.runAllTimersAsync();
      expect(await failure).toMatchObject({ name: 'ApiError', status: 500 });
      expectAbsent(canary);
      expect(logs).toContainEqual(['api_server_error', { route: '/journal/', status: 500 }]);
    },
  );
});
