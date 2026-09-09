import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadWritingOfferAnswered, saveWritingOfferAnswered } from '../writingOfferStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('writingOfferStorage', () => {
  test('records the answer so the next session does not ask again', async () => {
    await saveWritingOfferAnswered(true);

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
      '@adepthood/writing_habit_offer_answered',
      'true',
    );
  });

  test('can be cleared, so the flag is a record rather than a one-way door', async () => {
    await saveWritingOfferAnswered(false);

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
      '@adepthood/writing_habit_offer_answered',
      'false',
    );
  });

  test('reads back a recorded answer', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('true');

    await expect(loadWritingOfferAnswered()).resolves.toBe(true);
  });

  test('an offer never made has not been answered', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);

    await expect(loadWritingOfferAnswered()).resolves.toBe(false);
  });

  test('a storage failure offers rather than suppresses', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('storage error'));

    await expect(loadWritingOfferAnswered()).resolves.toBe(false);

    warn.mockRestore();
  });
});
