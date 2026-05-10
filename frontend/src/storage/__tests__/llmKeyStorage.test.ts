/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import * as SecureStore from 'expo-secure-store';

import { EmptyApiKeyError, clearLlmApiKey, loadLlmApiKey, saveLlmApiKey } from '../llmKeyStorage';

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(() => Promise.resolve()),
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('llmKeyStorage', () => {
  describe('saveLlmApiKey', () => {
    test('stores key in SecureStore under adepthood namespace', async () => {
      await saveLlmApiKey('sk-user-owned-key');

      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        'adepthood_llm_api_key',
        'sk-user-owned-key',
      );
    });

    test('BUG-FE-STORAGE-004: trims whitespace before storing', async () => {
      await saveLlmApiKey('  sk-padded-key  \n');
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        'adepthood_llm_api_key',
        'sk-padded-key',
      );
    });

    test('BUG-FE-STORAGE-004: rejects an empty key', async () => {
      await expect(saveLlmApiKey('')).rejects.toBeInstanceOf(EmptyApiKeyError);
      expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    });

    test('BUG-FE-STORAGE-004: rejects a whitespace-only key', async () => {
      await expect(saveLlmApiKey('   \n\t')).rejects.toBeInstanceOf(EmptyApiKeyError);
      expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    });
  });

  describe('loadLlmApiKey', () => {
    test('returns null when no key stored', async () => {
      mockSecureStore.getItemAsync.mockResolvedValueOnce(null);

      await expect(loadLlmApiKey()).resolves.toBeNull();
    });

    test('returns stored key when present', async () => {
      mockSecureStore.getItemAsync.mockResolvedValueOnce('sk-user-owned-key');

      await expect(loadLlmApiKey()).resolves.toBe('sk-user-owned-key');
    });
  });

  describe('clearLlmApiKey', () => {
    test('removes key from SecureStore', async () => {
      await clearLlmApiKey();

      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith('adepthood_llm_api_key');
    });
  });
});
