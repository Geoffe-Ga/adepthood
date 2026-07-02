import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { saveReturnOfferDismissed, loadReturnOfferDismissed } from '../returnOfferStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('returnOfferStorage', () => {
  describe('saveReturnOfferDismissed', () => {
    test('stores true when the offer is dismissed', async () => {
      await saveReturnOfferDismissed(true);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/return_offer_dismissed',
        'true',
      );
    });

    test('stores false when the flag is reset (episode advanced)', async () => {
      await saveReturnOfferDismissed(false);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/return_offer_dismissed',
        'false',
      );
    });
  });

  describe('loadReturnOfferDismissed', () => {
    test('returns false when nothing is stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);
      const result = await loadReturnOfferDismissed();
      expect(result).toBe(false);
    });

    test('returns true when the stored flag is true', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('true');
      const result = await loadReturnOfferDismissed();
      expect(result).toBe(true);
    });

    test('returns false on a storage error', async () => {
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('storage error'));
      const result = await loadReturnOfferDismissed();
      expect(result).toBe(false);
    });
  });
});
