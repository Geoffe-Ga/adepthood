/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import type * as LlmKeyStorageModule from '../llmKeyStorage';

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

function loadLlmKeyStorage(): typeof LlmKeyStorageModule {
  let mod: typeof LlmKeyStorageModule | undefined;
  jest.isolateModules(() => {
    mod = require('../llmKeyStorage') as typeof LlmKeyStorageModule;
  });
  if (!mod) throw new Error('failed to load llmKeyStorage');
  return mod;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('llmKeyStorage (native)', () => {
  beforeEach(() => {
    platformRef.value = 'ios';
  });

  describe('saveLlmApiKey', () => {
    test('stores key in SecureStore under adepthood namespace', async () => {
      const { saveLlmApiKey } = loadLlmKeyStorage();
      await saveLlmApiKey('sk-user-owned-key');

      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        'adepthood_llm_api_key',
        'sk-user-owned-key',
      );
      expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
    });

    test('BUG-FE-STORAGE-004: trims whitespace before storing', async () => {
      const { saveLlmApiKey } = loadLlmKeyStorage();
      await saveLlmApiKey('  sk-padded-key  \n');
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        'adepthood_llm_api_key',
        'sk-padded-key',
      );
    });

    test('BUG-FE-STORAGE-004: rejects an empty key', async () => {
      const { saveLlmApiKey, EmptyApiKeyError } = loadLlmKeyStorage();
      await expect(saveLlmApiKey('')).rejects.toBeInstanceOf(EmptyApiKeyError);
      expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    });

    test('BUG-FE-STORAGE-004: rejects a whitespace-only key', async () => {
      const { saveLlmApiKey, EmptyApiKeyError } = loadLlmKeyStorage();
      await expect(saveLlmApiKey('   \n\t')).rejects.toBeInstanceOf(EmptyApiKeyError);
      expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    });
  });

  describe('loadLlmApiKey', () => {
    test('returns null when no key stored', async () => {
      mockSecureStore.getItemAsync.mockResolvedValueOnce(null);
      const { loadLlmApiKey } = loadLlmKeyStorage();
      await expect(loadLlmApiKey()).resolves.toBeNull();
    });

    test('returns stored key when present', async () => {
      mockSecureStore.getItemAsync.mockResolvedValueOnce('sk-user-owned-key');
      const { loadLlmApiKey } = loadLlmKeyStorage();
      await expect(loadLlmApiKey()).resolves.toBe('sk-user-owned-key');
      expect(mockAsyncStorage.getItem).not.toHaveBeenCalled();
    });
  });

  describe('clearLlmApiKey', () => {
    test('removes key from SecureStore', async () => {
      const { clearLlmApiKey } = loadLlmKeyStorage();
      await clearLlmApiKey();

      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith('adepthood_llm_api_key');
      expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
    });
  });
});

describe('llmKeyStorage (web) (BUG-FE-STORAGE-001)', () => {
  // ``expo-secure-store`` v55 ships no web implementation, so the native
  // branch throws ``TypeError`` on Expo Web and the BYOK settings screen
  // crashes.  The web branch falls back to ``AsyncStorage``; these tests
  // pin every operation to that path.
  beforeEach(() => {
    platformRef.value = 'web';
  });

  test('saveLlmApiKey routes to AsyncStorage on web', async () => {
    const { saveLlmApiKey } = loadLlmKeyStorage();
    await saveLlmApiKey('sk-user-owned-key');
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
      'adepthood_llm_api_key',
      'sk-user-owned-key',
    );
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  test('saveLlmApiKey trims and rejects empty input on web', async () => {
    const { saveLlmApiKey, EmptyApiKeyError } = loadLlmKeyStorage();
    await saveLlmApiKey('  sk-padded \n');
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith('adepthood_llm_api_key', 'sk-padded');
    await expect(saveLlmApiKey('')).rejects.toBeInstanceOf(EmptyApiKeyError);
  });

  test('loadLlmApiKey reads from AsyncStorage on web', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('sk-user-owned-key');
    const { loadLlmApiKey } = loadLlmKeyStorage();
    await expect(loadLlmApiKey()).resolves.toBe('sk-user-owned-key');
    expect(mockSecureStore.getItemAsync).not.toHaveBeenCalled();
  });

  test('clearLlmApiKey removes from AsyncStorage on web', async () => {
    const { clearLlmApiKey } = loadLlmKeyStorage();
    await clearLlmApiKey();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('adepthood_llm_api_key');
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });
});
