/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadRecentPractices,
  recordRecentPractice,
  MAX_RECENT_PRACTICES,
  type RecentPractice,
} from '../recentPracticesStorage';
import { _resetSerializedWriteForTests } from '../serializedWrite';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const STORAGE_KEY = '@adepthood/recent_practices';

function makePractice(id: number): RecentPractice {
  return { id, name: `Practice ${id}`, mode: 'guided', durationMinutes: 10 };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
});

describe('loadRecentPractices', () => {
  test('returns an empty list when nothing is stored', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);

    const result = await loadRecentPractices();
    expect(result).toEqual([]);
  });

  test('returns the stored list, filtering bad entries and slicing to the max', async () => {
    const valid = Array.from({ length: MAX_RECENT_PRACTICES + 2 }, (_, i) => makePractice(i + 1));
    const badEntry = { id: 999, name: 'Missing duration' };
    const stored = [...valid, badEntry];
    mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify(stored));

    const result = await loadRecentPractices();
    expect(result).toHaveLength(MAX_RECENT_PRACTICES);
    expect(result).toEqual(valid.slice(0, MAX_RECENT_PRACTICES));
  });

  test('a transient getItem rejection returns an empty list without clearing the key', async () => {
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('transient read'));

    const result = await loadRecentPractices();
    expect(result).toEqual([]);
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  test('self-heals corrupt JSON by clearing the key', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('not valid json{{{');

    const result = await loadRecentPractices();
    expect(result).toEqual([]);
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
  });

  test('sanitizes a valid non-array payload to an empty list without clearing the key', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify({}));

    const result = await loadRecentPractices();
    expect(result).toEqual([]);
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });
});

describe('recordRecentPractice', () => {
  test('prepends a new entry and persists it', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);

    await recordRecentPractice(makePractice(1));

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify([makePractice(1)]),
    );
  });

  test('dedupes by id, moving an existing entry to the front', async () => {
    const existing = [makePractice(1), makePractice(2), makePractice(3)];
    mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify(existing));

    await recordRecentPractice(makePractice(2));

    const stored = mockAsyncStorage.setItem.mock.calls[0]![1] as string;
    const parsed = JSON.parse(stored) as RecentPractice[];
    expect(parsed.map((p) => p.id)).toEqual([2, 1, 3]);
  });

  test('slices to MAX_RECENT_PRACTICES when prepending would overflow', async () => {
    const existing = Array.from({ length: MAX_RECENT_PRACTICES }, (_, i) => makePractice(i + 1));
    mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify(existing));

    await recordRecentPractice(makePractice(999));

    const stored = mockAsyncStorage.setItem.mock.calls[0]![1] as string;
    const parsed = JSON.parse(stored) as RecentPractice[];
    expect(parsed).toHaveLength(MAX_RECENT_PRACTICES);
    expect(parsed[0]!.id).toBe(999);
    expect(parsed.map((p) => p.id)).not.toContain(MAX_RECENT_PRACTICES);
  });

  test('a transient read failure preserves the intact on-disk list', async () => {
    const intact = [makePractice(1), makePractice(2)];
    const rawOnDisk = JSON.stringify(intact);
    const store: { raw: string | null } = { raw: rawOnDisk };
    mockAsyncStorage.getItem
      .mockRejectedValueOnce(new Error('transient read'))
      .mockImplementation(() => Promise.resolve(store.raw));
    mockAsyncStorage.setItem.mockImplementation((_key: string, value: string) => {
      store.raw = value;
      return Promise.resolve();
    });

    await recordRecentPractice(makePractice(3));

    expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(store.raw).toBe(rawOnDisk);

    mockAsyncStorage.getItem.mockImplementation(() => Promise.resolve(null));
    mockAsyncStorage.setItem.mockImplementation(() => Promise.resolve());
  });

  test('two concurrent recordings both survive instead of clobbering each other', async () => {
    const store: { raw: string | null } = { raw: null };
    mockAsyncStorage.getItem.mockImplementation(() => Promise.resolve(store.raw));
    mockAsyncStorage.setItem.mockImplementation((_key: string, value: string) => {
      store.raw = value;
      return Promise.resolve();
    });

    await Promise.all([
      recordRecentPractice(makePractice(1)),
      recordRecentPractice(makePractice(2)),
    ]);

    const parsed = JSON.parse(store.raw as string) as RecentPractice[];
    expect(parsed.map((p) => p.id)).toEqual([2, 1]);

    mockAsyncStorage.getItem.mockImplementation(() => Promise.resolve(null));
    mockAsyncStorage.setItem.mockImplementation(() => Promise.resolve());
  });
});
