import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadEnergyScaffoldingArchived,
  saveEnergyScaffoldingArchived,
} from '../energyScaffoldingStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('energyScaffoldingStorage', () => {
  const KEY = '@adepthood/energy_scaffolding_archived';

  describe('saveEnergyScaffoldingArchived', () => {
    test('persists the archived flag as JSON', async () => {
      await saveEnergyScaffoldingArchived(true);
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(KEY, 'true');
    });

    test('persists a cleared flag as JSON', async () => {
      await saveEnergyScaffoldingArchived(false);
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(KEY, 'false');
    });
  });

  describe('loadEnergyScaffoldingArchived', () => {
    test('returns false when nothing is stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);
      await expect(loadEnergyScaffoldingArchived()).resolves.toBe(false);
    });

    test('returns the stored boolean', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('true');
      await expect(loadEnergyScaffoldingArchived()).resolves.toBe(true);
    });

    test('clears the key and returns false for a non-boolean value', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('"yes"');
      await expect(loadEnergyScaffoldingArchived()).resolves.toBe(false);
      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(KEY);
    });

    test('clears the key and returns false for malformed JSON', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('{not json');
      await expect(loadEnergyScaffoldingArchived()).resolves.toBe(false);
      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(KEY);
    });

    test('returns false without deleting data when AsyncStorage throws', async () => {
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('boom'));
      await expect(loadEnergyScaffoldingArchived()).resolves.toBe(false);
      expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
    });
  });
});
