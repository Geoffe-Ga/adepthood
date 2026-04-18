/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import type * as AuthStorageModule from '../authStorage';

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

function loadAuthStorage(): typeof AuthStorageModule {
  let mod: typeof AuthStorageModule | undefined;
  jest.isolateModules(() => {
    mod = require('../authStorage') as typeof AuthStorageModule;
  });
  if (!mod) throw new Error('failed to load authStorage');
  return mod;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('authStorage (native)', () => {
  beforeEach(() => {
    platformRef.value = 'ios';
  });

  test('saveToken routes to SecureStore on native', async () => {
    const { saveToken } = loadAuthStorage();
    await saveToken('my-jwt-token');
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      'adepthood_auth_token',
      'my-jwt-token',
    );
    expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('loadToken reads from SecureStore on native', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce('my-jwt-token');
    const { loadToken } = loadAuthStorage();
    await expect(loadToken()).resolves.toBe('my-jwt-token');
    expect(mockAsyncStorage.getItem).not.toHaveBeenCalled();
  });

  test('clearToken removes from SecureStore on native', async () => {
    const { clearToken } = loadAuthStorage();
    await clearToken();
    expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith('adepthood_auth_token');
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });
});

describe('authStorage (web)', () => {
  // ``expo-secure-store`` v55 ships no web implementation (its web bundle is
  // literally ``export default {}``), so the native branch would throw
  // ``TypeError`` and every auth call in the Expo Web build would fall back
  // to the generic ``SIGNUP_FALLBACK`` copy. These cases pin the
  // AsyncStorage fallback in place.
  beforeEach(() => {
    platformRef.value = 'web';
  });

  test('saveToken routes to AsyncStorage on web', async () => {
    const { saveToken } = loadAuthStorage();
    await saveToken('my-jwt-token');
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith('adepthood_auth_token', 'my-jwt-token');
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  test('loadToken reads from AsyncStorage on web', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('my-jwt-token');
    const { loadToken } = loadAuthStorage();
    await expect(loadToken()).resolves.toBe('my-jwt-token');
    expect(mockSecureStore.getItemAsync).not.toHaveBeenCalled();
  });

  test('clearToken removes from AsyncStorage on web', async () => {
    const { clearToken } = loadAuthStorage();
    await clearToken();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('adepthood_auth_token');
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });
});
