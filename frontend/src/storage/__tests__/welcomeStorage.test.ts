import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearHasSeenWelcome, loadHasSeenWelcome, saveHasSeenWelcome } from '../welcomeStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;
const KEY = '@adepthood/has_seen_welcome';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('welcomeStorage', () => {
  test('saveHasSeenWelcome writes the true flag', async () => {
    await saveHasSeenWelcome();
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(KEY, 'true');
  });

  test('loadHasSeenWelcome returns false when unset', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    expect(await loadHasSeenWelcome()).toBe(false);
  });

  test('loadHasSeenWelcome returns true once set', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('true');
    expect(await loadHasSeenWelcome()).toBe(true);
  });

  test('loadHasSeenWelcome swallows storage errors as false', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('boom'));
    expect(await loadHasSeenWelcome()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('clearHasSeenWelcome removes the key', async () => {
    await clearHasSeenWelcome();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(KEY);
  });
});
