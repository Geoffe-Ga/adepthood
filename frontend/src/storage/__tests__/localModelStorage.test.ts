/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  LOCAL_MODEL_PREFERRED_KEY,
  loadLocalModelPreferred,
  saveLocalModelPreferred,
} from '../localModelStorage';

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('localModelStorage', () => {
  test('empty storage reads as no choice, so the context applies its default', async () => {
    await expect(loadLocalModelPreferred()).resolves.toBeNull();
  });

  test.each([
    [true, 'true'],
    [false, 'false'],
  ])(
    'a saved %p is written as %p under its key, read back, and resolves that it saved',
    async (value, raw) => {
      await expect(saveLocalModelPreferred(value)).resolves.toBe(true);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(LOCAL_MODEL_PREFERRED_KEY, raw);
      await expect(loadLocalModelPreferred()).resolves.toBe(value);
    },
  );

  test.each(['yes', '1', ''])('a stored %p is no choice at all', async (raw) => {
    await AsyncStorage.setItem(LOCAL_MODEL_PREFERRED_KEY, raw);

    await expect(loadLocalModelPreferred()).resolves.toBeNull();
  });

  test('a read error fails to "no choice" and says so, rather than inventing one', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('storage error');
    mockAsyncStorage.getItem.mockRejectedValueOnce(error);

    await expect(loadLocalModelPreferred()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[localModelStorage] failed to load the choice', error);
  });

  test('a failed write resolves false and says so rather than rejecting', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('quota exceeded');
    mockAsyncStorage.setItem.mockRejectedValueOnce(error);

    await expect(saveLocalModelPreferred(true)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[localModelStorage] failed to save the choice', error);
  });
});
