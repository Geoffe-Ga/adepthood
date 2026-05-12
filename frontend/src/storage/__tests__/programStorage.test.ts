import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearProgramStartDate,
  loadProgramStartDate,
  saveProgramStartDate,
} from '../programStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('programStorage', () => {
  const KEY = '@adepthood/program_start_date';

  describe('saveProgramStartDate', () => {
    test('serialises the date to an ISO YYYY-MM-DD string', async () => {
      await saveProgramStartDate(new Date(2026, 4, 12)); // 2026-05-12 local
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(KEY, '2026-05-12');
    });

    test('uses the local calendar day, not UTC', async () => {
      // 11pm local on the 12th — naively calling toISOString() would
      // bucket this into the 13th in many timezones.
      const date = new Date(2026, 4, 12, 23, 30);
      await saveProgramStartDate(date);
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(KEY, '2026-05-12');
    });
  });

  describe('loadProgramStartDate', () => {
    test('returns null when nothing is stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);
      await expect(loadProgramStartDate()).resolves.toBeNull();
    });

    test('parses a stored ISO date back to a local Date', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('2026-05-12');
      const date = await loadProgramStartDate();
      expect(date).toBeInstanceOf(Date);
      expect(date?.getFullYear()).toBe(2026);
      expect(date?.getMonth()).toBe(4);
      expect(date?.getDate()).toBe(12);
    });

    test('returns null for a malformed value rather than throwing', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('not-a-date');
      await expect(loadProgramStartDate()).resolves.toBeNull();
    });

    test('returns null when AsyncStorage throws', async () => {
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('boom'));
      await expect(loadProgramStartDate()).resolves.toBeNull();
    });
  });

  describe('clearProgramStartDate', () => {
    test('removes the stored date', async () => {
      await clearProgramStartDate();
      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(KEY);
    });
  });
});
