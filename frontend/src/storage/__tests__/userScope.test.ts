/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  getActiveUser,
  loadDeviceOwner,
  parseUserId,
  saveDeviceOwner,
  scopedKey,
  setActiveUser,
} from '../userScope';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const DEVICE_OWNER_KEY = '@adepthood/device_owner';

beforeEach(() => {
  setActiveUser(null);
  mockAsyncStorage.getItem.mockResolvedValue(null);
});

describe('scopedKey', () => {
  test('returns the key unchanged while anonymous', () => {
    expect(scopedKey('@adepthood/habits')).toBe('@adepthood/habits');
  });

  test('gives each account its own key for the same cache', () => {
    setActiveUser(1);
    const forUserOne = scopedKey('@adepthood/habits');
    setActiveUser(2);
    const forUserTwo = scopedKey('@adepthood/habits');

    expect(forUserOne).not.toBe(forUserTwo);
    expect(forUserOne).toContain('@adepthood/habits');
    expect(forUserTwo).toContain('@adepthood/habits');
  });

  test('a scoped key never collides with the unscoped one', () => {
    setActiveUser(7);
    expect(scopedKey('@adepthood/habits')).not.toBe('@adepthood/habits');
  });

  test('reports the account the keys currently resolve to', () => {
    expect(getActiveUser()).toBeNull();
    setActiveUser(42);
    expect(getActiveUser()).toBe(42);
  });
});

describe('the device-owner stamp', () => {
  test('records the owner as a plain id', async () => {
    await saveDeviceOwner(9);
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(DEVICE_OWNER_KEY, '9');
  });

  test('reads back the id it recorded', async () => {
    mockAsyncStorage.getItem.mockResolvedValue('9');
    expect(await loadDeviceOwner()).toBe(9);
  });

  test('reads an unstamped device as no owner', async () => {
    expect(await loadDeviceOwner()).toBeNull();
  });

  test('reads a corrupt stamp as no owner rather than trusting it', async () => {
    mockAsyncStorage.getItem.mockResolvedValue('not-a-user');
    expect(await loadDeviceOwner()).toBeNull();
  });

  test('rejects a non-positive id, which no real account has', async () => {
    mockAsyncStorage.getItem.mockResolvedValue('0');
    expect(await loadDeviceOwner()).toBeNull();
  });

  test('reads a transient storage failure as no owner, so the caller errs toward wiping', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAsyncStorage.getItem.mockRejectedValue(new Error('disk busy'));

    expect(await loadDeviceOwner()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('parseUserId', () => {
  // Two sources name the device's owner -- the persisted stamp and the JWT's
  // ``sub`` claim -- and they share this parser so neither can accept an id
  // the other rejects. The backend stringifies the id when it signs, but its
  // own decoder takes ``str | int``, so both shapes have to land the same way.
  test('accepts an account id as either a string or a number', () => {
    expect(parseUserId('7')).toBe(7);
    expect(parseUserId(7)).toBe(7);
  });

  test('rejects everything that does not positively name an account', () => {
    expect(parseUserId('not-a-user')).toBeNull();
    expect(parseUserId('0')).toBeNull();
    expect(parseUserId(0)).toBeNull();
    expect(parseUserId(-3)).toBeNull();
    expect(parseUserId(1.5)).toBeNull();
    expect(parseUserId(null)).toBeNull();
    expect(parseUserId(undefined)).toBeNull();
    expect(parseUserId({ id: 7 })).toBeNull();
  });
});
