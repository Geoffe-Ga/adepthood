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
