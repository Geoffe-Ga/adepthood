/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { clearLogoutPending, isLogoutPending, markLogoutPending } from '../authStorage';
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

  test('BUG-FE-STORAGE-004: saveToken trims whitespace before storing', async () => {
    const { saveToken } = loadAuthStorage();
    await saveToken('  my-jwt-token \n');
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith('adepthood_auth_token', 'my-jwt-token');
  });

  test('BUG-FE-STORAGE-004: saveToken rejects empty / whitespace-only input', async () => {
    const { saveToken, EmptyAuthTokenError } = loadAuthStorage();
    await expect(saveToken('')).rejects.toBeInstanceOf(EmptyAuthTokenError);
    await expect(saveToken('   ')).rejects.toBeInstanceOf(EmptyAuthTokenError);
    expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
  });
});

// BUG-FE-STATE-001: independent of the SecureStore JWT, always AsyncStorage-backed.
describe('authStorage logout-pending marker (BUG-FE-STATE-001)', () => {
  const LOGOUT_PENDING_KEY = '@adepthood/logout_pending';

  test('markLogoutPending writes the pending flag', async () => {
    await markLogoutPending();
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(LOGOUT_PENDING_KEY, 'true');
  });

  test('isLogoutPending returns false when unset', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    expect(await isLogoutPending()).toBe(false);
  });

  test('isLogoutPending returns true once marked', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('true');
    expect(await isLogoutPending()).toBe(true);
  });

  test('isLogoutPending swallows storage errors as false', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('boom'));
    expect(await isLogoutPending()).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('clearLogoutPending removes the pending flag', async () => {
    await clearLogoutPending();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(LOGOUT_PENDING_KEY);
  });
});

/**
 * #2847: the zone a resumed session has to come back with.
 *
 * The JWT carries no ``timezone`` claim, so a cold start that only reads the
 * token knows the user's credential but not their calendar. This slot is the
 * last zone the *server* confirmed, cached beside the token — never a
 * device-clock guess.
 */
describe('authStorage user timezone (#2847)', () => {
  const USER_TIMEZONE_KEY = '@adepthood/user_timezone';

  test('saveUserTimezone records the server-confirmed zone', async () => {
    const { saveUserTimezone } = loadAuthStorage();
    await saveUserTimezone('America/Los_Angeles');
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(USER_TIMEZONE_KEY, 'America/Los_Angeles');
  });

  test('loadUserTimezone returns null when nothing was ever stored', async () => {
    const { loadUserTimezone } = loadAuthStorage();
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    expect(await loadUserTimezone()).toBeNull();
  });

  test('loadUserTimezone returns the stored zone', async () => {
    const { loadUserTimezone } = loadAuthStorage();
    mockAsyncStorage.getItem.mockResolvedValueOnce('America/Los_Angeles');
    expect(await loadUserTimezone()).toBe('America/Los_Angeles');
  });

  test('loadUserTimezone treats a blank value as absent', async () => {
    // An empty string is not a zone; returning it would make every "today"
    // fall back to the runtime's own calendar, which is the one source #261
    // forbids.
    const { loadUserTimezone } = loadAuthStorage();
    mockAsyncStorage.getItem.mockResolvedValueOnce('   ');
    expect(await loadUserTimezone()).toBeNull();
  });

  test('loadUserTimezone swallows storage errors as absent', async () => {
    const { loadUserTimezone } = loadAuthStorage();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('boom'));
    expect(await loadUserTimezone()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('saveUserTimezone never rejects: a failed cache must not break a sign-in', async () => {
    const { saveUserTimezone } = loadAuthStorage();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAsyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(saveUserTimezone('Europe/Berlin')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('clearUserTimezone removes the cached zone', async () => {
    const { clearUserTimezone } = loadAuthStorage();
    await clearUserTimezone();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(USER_TIMEZONE_KEY);
  });
});
