/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import type * as SecureStringStoreModule from '../secureStringStore';

const platformRef = { value: 'ios' as 'ios' | 'android' | 'web' };

jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformRef.value;
    },
  },
}));

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(() => Promise.resolve()),
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;
const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const TEST_KEY = 'test_secure_key';

class TestEmptyError extends Error {}

function loadSecureStringStore(): typeof SecureStringStoreModule {
  let mod: typeof SecureStringStoreModule | undefined;
  jest.isolateModules(() => {
    mod = require('../secureStringStore') as typeof SecureStringStoreModule;
  });
  if (!mod) throw new Error('failed to load secureStringStore');
  return mod;
}

function makeStore() {
  const { createSecureStringStore } = loadSecureStringStore();
  return createSecureStringStore(TEST_KEY, TestEmptyError);
}

// Microtask rounds pumped so a serialized write chain enqueues each successive
// write; generous because every write hops the FIFO chain several times.
const MAX_DRAIN_ROUNDS = 50;

// Commit deferred mock writes newest-first (a later write settling before an
// earlier one), pumping microtasks so a serialized chain runs to completion. A
// momentarily empty queue is not the end — a chained write may not be enqueued yet.
async function drainNewestFirst(pending: Array<() => void>): Promise<void> {
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
    await Promise.resolve();
    if (pending.length === 0) continue;
    const batch = pending.splice(0).reverse();
    for (const commit of batch) commit();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createSecureStringStore (native)', () => {
  beforeEach(() => {
    platformRef.value = 'ios';
  });

  test('save routes to SecureStore on native', async () => {
    const store = makeStore();
    await store.save('some-value');
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(TEST_KEY, 'some-value');
    expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('load reads from SecureStore on native', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce('some-value');
    const store = makeStore();
    await expect(store.load()).resolves.toBe('some-value');
    expect(mockAsyncStorage.getItem).not.toHaveBeenCalled();
  });

  test('clear removes from SecureStore on native', async () => {
    const store = makeStore();
    await store.clear();
    expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(TEST_KEY);
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });
});

describe('createSecureStringStore (web)', () => {
  beforeEach(() => {
    platformRef.value = 'web';
  });

  test('save routes to AsyncStorage on web', async () => {
    const store = makeStore();
    await store.save('some-value');
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(TEST_KEY, 'some-value');
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  test('load reads from AsyncStorage on web', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('some-value');
    const store = makeStore();
    await expect(store.load()).resolves.toBe('some-value');
    expect(mockSecureStore.getItemAsync).not.toHaveBeenCalled();
  });

  test('clear removes from AsyncStorage on web', async () => {
    const store = makeStore();
    await store.clear();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(TEST_KEY);
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  test('save trims whitespace before storing', async () => {
    const store = makeStore();
    await store.save('  val \n');
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(TEST_KEY, 'val');
  });

  test('save rejects empty / whitespace-only input with the passed error ctor', async () => {
    const store = makeStore();
    await expect(store.save('')).rejects.toBeInstanceOf(TestEmptyError);
    await expect(store.save('   ')).rejects.toBeInstanceOf(TestEmptyError);
    expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  test('load returns null passthrough when the underlying store returns null', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    const store = makeStore();
    await expect(store.load()).resolves.toBeNull();
  });

  test('load propagates rejection when the underlying store rejects', async () => {
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('read boom'));
    const store = makeStore();
    await expect(store.load()).rejects.toThrow('read boom');
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });
});

describe('createSecureStringStore (native write ordering)', () => {
  beforeEach(() => {
    platformRef.value = 'ios';
  });

  test('a fresh save always wins over a stale save issued earlier', async () => {
    let stored: string | null = null;
    const pending: Array<() => void> = [];
    mockSecureStore.setItemAsync.mockImplementation(
      (_key: string, val: string) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            stored = val;
            resolve();
          });
        }),
    );

    const store = makeStore();
    const pStale = store.save('stale-token');
    const pFresh = store.save('fresh-token');

    await drainNewestFirst(pending);
    await Promise.all([pStale, pFresh]);

    expect(stored).toBe('fresh-token');
  });

  test('a clear issued after a save is never overwritten by the save settling late', async () => {
    let stored: string | null = null;
    const pending: Array<() => void> = [];
    mockSecureStore.setItemAsync.mockImplementation(
      (_key: string, val: string) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            stored = val;
            resolve();
          });
        }),
    );
    mockSecureStore.deleteItemAsync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            stored = null;
            resolve();
          });
        }),
    );

    const store = makeStore();
    const pSave = store.save('fresh-token');
    const pClear = store.clear();

    await drainNewestFirst(pending);
    await Promise.all([pSave, pClear]);

    expect(stored).toBeNull();
  });

  test('a held write on one key does not block a write on a different key', async () => {
    const { createSecureStringStore } = loadSecureStringStore();
    const storeA = createSecureStringStore('key-a', TestEmptyError);
    const storeB = createSecureStringStore('key-b', TestEmptyError);

    let resolveA: () => void = () => undefined;
    mockSecureStore.setItemAsync.mockImplementation((key: string) =>
      key === 'key-a'
        ? new Promise<void>((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve(),
    );

    const pA = storeA.save('a-value');
    const pB = storeB.save('b-value');

    await expect(pB).resolves.toBeUndefined();
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith('key-b', 'b-value');

    resolveA();
    await pA;
  });

  test('a rejected save does not wedge the lane for the same key', async () => {
    const store = makeStore();
    mockSecureStore.setItemAsync.mockRejectedValueOnce(new Error('keychain write failed'));

    await expect(store.save('will-fail')).rejects.toThrow('keychain write failed');

    mockSecureStore.setItemAsync.mockResolvedValueOnce(undefined);
    await store.save('recovers');

    expect(mockSecureStore.setItemAsync).toHaveBeenLastCalledWith(TEST_KEY, 'recovers');
  });
});

describe('createSecureStringStore (web write ordering)', () => {
  beforeEach(() => {
    platformRef.value = 'web';
  });

  test('a fresh save always wins over a stale save issued earlier on web', async () => {
    let stored: string | null = null;
    const pending: Array<() => void> = [];
    mockAsyncStorage.setItem.mockImplementation(
      (_key: string, val: string) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            stored = val;
            resolve();
          });
        }),
    );

    const store = makeStore();
    const pStale = store.save('stale-token');
    const pFresh = store.save('fresh-token');

    await drainNewestFirst(pending);
    await Promise.all([pStale, pFresh]);

    expect(stored).toBe('fresh-token');
  });
});
