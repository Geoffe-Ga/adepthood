import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  saveMorningPagesTipDismissed,
  loadMorningPagesTipDismissed,
} from '../morningPagesTipStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('morningPagesTipStorage', () => {
  describe('saveMorningPagesTipDismissed', () => {
    test('stores true when the tip is dismissed', async () => {
      await saveMorningPagesTipDismissed(true);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/morning_pages_tip_dismissed',
        'true',
      );
    });
  });

  describe('loadMorningPagesTipDismissed', () => {
    test('returns false when nothing is stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);
      const result = await loadMorningPagesTipDismissed();
      expect(result).toBe(false);
    });

    test('returns true when the stored flag is true', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('true');
      const result = await loadMorningPagesTipDismissed();
      expect(result).toBe(true);
    });

    test('returns false on a storage error', async () => {
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('storage error'));
      const result = await loadMorningPagesTipDismissed();
      expect(result).toBe(false);
    });
  });
});
