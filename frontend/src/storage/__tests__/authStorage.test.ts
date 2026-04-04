/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import * as SecureStore from 'expo-secure-store';

import { saveToken, loadToken, clearToken } from '../authStorage';

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(() => Promise.resolve()),
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('authStorage', () => {
  describe('saveToken', () => {
    test('stores token in SecureStore', async () => {
      await saveToken('my-jwt-token');

      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        '@adepthood/auth_token',
        'my-jwt-token',
      );
    });
  });

  describe('loadToken', () => {
    test('returns null when no token stored', async () => {
      mockSecureStore.getItemAsync.mockResolvedValueOnce(null);

      const result = await loadToken();
      expect(result).toBeNull();
    });

    test('returns stored token', async () => {
      mockSecureStore.getItemAsync.mockResolvedValueOnce('my-jwt-token');

      const result = await loadToken();
      expect(result).toBe('my-jwt-token');
    });
  });

  describe('clearToken', () => {
    test('removes token from SecureStore', async () => {
      await clearToken();
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith('@adepthood/auth_token');
    });
  });
});
