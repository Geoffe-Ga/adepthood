// RED: `reflectionDismissalStorage` does not exist yet -- this import fails
// until the implementation-specialist adds the module (mirrors
// `returnOfferStorage.ts`, keyed per reflection scope instead of globally).
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { saveReflectionDismissed, loadReflectionDismissed } from '../reflectionDismissalStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reflectionDismissalStorage', () => {
  describe('saveReflectionDismissed', () => {
    test('stores true under a scope-key-specific storage key', async () => {
      await saveReflectionDismissed('c1:w14', true);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/reflection_dismissed:c1:w14',
        'true',
      );
    });

    test('stores false when a dismissal is reset', async () => {
      await saveReflectionDismissed('c1:w14', false);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/reflection_dismissed:c1:w14',
        'false',
      );
    });
  });

  describe('loadReflectionDismissed', () => {
    test('returns false for an unknown scope key', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);
      const result = await loadReflectionDismissed('c1:s1');
      expect(result).toBe(false);
    });

    test('returns true when the stored flag is true', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('true');
      const result = await loadReflectionDismissed('c1:w14');
      expect(result).toBe(true);
    });

    test('keeps distinct scope keys independent -- dismissing one leaves another false', async () => {
      mockAsyncStorage.getItem.mockImplementation((key: string) =>
        Promise.resolve(key === '@adepthood/reflection_dismissed:c1:w14' ? 'true' : null),
      );

      expect(await loadReflectionDismissed('c1:w14')).toBe(true);
      expect(await loadReflectionDismissed('c1:s1')).toBe(false);
    });

    test('returns false on a storage error rather than throwing', async () => {
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('storage error'));
      const result = await loadReflectionDismissed('c1:w14');
      expect(result).toBe(false);
    });
  });
});
