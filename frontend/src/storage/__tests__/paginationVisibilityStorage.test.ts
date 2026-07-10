// RED: paginationVisibilityStorage does not exist yet -- this import fails
// until the implementation-specialist adds the module (mirrors
// reflectionDismissalStorage.ts, but a single global flag rather than a
// per-scope one).
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { savePaginationBarHidden, loadPaginationBarHidden } from '../paginationVisibilityStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('paginationVisibilityStorage', () => {
  describe('savePaginationBarHidden', () => {
    test('stores "true" under the pagination-hidden key', async () => {
      await savePaginationBarHidden(true);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/habits_pagination_hidden',
        'true',
      );
    });

    test('stores "false" when the bar is shown again', async () => {
      await savePaginationBarHidden(false);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/habits_pagination_hidden',
        'false',
      );
    });

    test('swallows a write error instead of rejecting', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockAsyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'));

      await expect(savePaginationBarHidden(true)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('loadPaginationBarHidden', () => {
    test('fails open to false (visible) when nothing is stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);
      const result = await loadPaginationBarHidden();
      expect(result).toBe(false);
    });

    test('returns true only when the stored value is exactly "true"', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('true');
      const result = await loadPaginationBarHidden();
      expect(result).toBe(true);
    });

    test('treats any non-"true" stored value as visible', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('false');
      const result = await loadPaginationBarHidden();
      expect(result).toBe(false);
    });

    test('fails open to false on a storage read error rather than throwing', async () => {
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('storage error'));
      await expect(loadPaginationBarHidden()).resolves.toBe(false);
    });
  });
});
