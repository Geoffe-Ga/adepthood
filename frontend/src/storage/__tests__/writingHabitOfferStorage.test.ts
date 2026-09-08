import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadWritingHabitOfferAnswered,
  saveWritingHabitOfferAnswered,
} from '../writingHabitOfferStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('writingHabitOfferStorage', () => {
  test('records the answer so the next session does not ask again', async () => {
    await saveWritingHabitOfferAnswered(true);

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
      '@adepthood/writing_habit_offer_answered',
      'true',
    );
  });

  test('can be cleared, so the flag is a record rather than a one-way door', async () => {
    await saveWritingHabitOfferAnswered(false);

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
      '@adepthood/writing_habit_offer_answered',
      'false',
    );
  });

  test('reads back a recorded answer', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('true');

    await expect(loadWritingHabitOfferAnswered()).resolves.toBe(true);
  });

  test('an offer never made has not been answered', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);

    await expect(loadWritingHabitOfferAnswered()).resolves.toBe(false);
  });

  test('a storage failure offers rather than suppresses', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('storage error'));

    await expect(loadWritingHabitOfferAnswered()).resolves.toBe(false);

    warn.mockRestore();
  });
});
