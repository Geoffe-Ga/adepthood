/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  saveNotificationIds,
  loadNotificationIds,
  clearNotificationIds,
} from '../notificationStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('notificationStorage', () => {
  describe('saveNotificationIds', () => {
    test('stores notification IDs keyed by habit ID', async () => {
      await saveNotificationIds(42, ['notif-1', 'notif-2']);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/notifications/42',
        JSON.stringify(['notif-1', 'notif-2']),
      );
    });
  });

  describe('loadNotificationIds', () => {
    test('returns empty array when no data stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);

      const result = await loadNotificationIds(42);
      expect(result).toEqual([]);
    });

    test('returns stored notification IDs', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify(['notif-1', 'notif-2']));

      const result = await loadNotificationIds(42);
      expect(result).toEqual(['notif-1', 'notif-2']);
    });

    test('returns empty array on corrupted data', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('bad json{');

      const result = await loadNotificationIds(42);
      expect(result).toEqual([]);
    });
  });

  describe('clearNotificationIds', () => {
    test('removes notification IDs for a habit', async () => {
      await clearNotificationIds(42);
      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/notifications/42');
    });
  });
});
