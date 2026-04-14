import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import {
  saveNotificationIds,
  loadNotificationIds,
  clearNotificationIds,
  loadAllNotificationMappings,
  savePushToken,
  loadPushToken,
} from '../notificationStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(() => Promise.resolve()),
  getItemAsync: jest.fn(() => Promise.resolve(null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;
const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

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

    test('tracks the habit ID for bulk loading', async () => {
      await saveNotificationIds(42, ['notif-1']);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/notification_habit_ids',
        JSON.stringify([42]),
      );
    });

    test('does not duplicate habit IDs in the tracking list', async () => {
      mockAsyncStorage.getItem.mockImplementation(async (key: string) => {
        if (key === '@adepthood/notification_habit_ids') return JSON.stringify([42]);
        return null;
      });

      await saveNotificationIds(42, ['notif-1']);

      // setItem should be called once for the notification IDs but NOT for the tracking list
      const trackingCalls = mockAsyncStorage.setItem.mock.calls.filter(
        ([k]) => k === '@adepthood/notification_habit_ids',
      );
      expect(trackingCalls).toHaveLength(0);
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
      mockAsyncStorage.getItem.mockImplementation(async (key: string) => {
        if (key === '@adepthood/notification_habit_ids') return JSON.stringify([42, 99]);
        return null;
      });

      await clearNotificationIds(42);
      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/notifications/42');
    });

    test('removes habit ID from tracking list', async () => {
      mockAsyncStorage.getItem.mockImplementation(async (key: string) => {
        if (key === '@adepthood/notification_habit_ids') return JSON.stringify([42, 99]);
        return null;
      });

      await clearNotificationIds(42);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/notification_habit_ids',
        JSON.stringify([99]),
      );
    });
  });

  describe('loadAllNotificationMappings', () => {
    test('returns empty object when no habits tracked', async () => {
      const result = await loadAllNotificationMappings();
      expect(result).toEqual({});
    });

    test('returns mappings for all tracked habits', async () => {
      mockAsyncStorage.getItem.mockImplementation(async (key: string) => {
        if (key === '@adepthood/notification_habit_ids') return JSON.stringify([1, 2]);
        if (key === '@adepthood/notifications/1') return JSON.stringify(['a', 'b']);
        if (key === '@adepthood/notifications/2') return JSON.stringify(['c']);
        return null;
      });

      const result = await loadAllNotificationMappings();
      expect(result).toEqual({ 1: ['a', 'b'], 2: ['c'] });
    });

    test('skips habits with empty notification arrays', async () => {
      mockAsyncStorage.getItem.mockImplementation(async (key: string) => {
        if (key === '@adepthood/notification_habit_ids') return JSON.stringify([1, 2]);
        if (key === '@adepthood/notifications/1') return JSON.stringify(['a']);
        if (key === '@adepthood/notifications/2') return null;
        return null;
      });

      const result = await loadAllNotificationMappings();
      expect(result).toEqual({ 1: ['a'] });
    });
  });

  describe('savePushToken', () => {
    test('stores the push token in SecureStore', async () => {
      await savePushToken('ExponentPushToken[abc]');
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        'adepthood_push_token',
        'ExponentPushToken[abc]',
      );
    });
  });

  describe('loadPushToken', () => {
    test('returns null when no token stored', async () => {
      const result = await loadPushToken();
      expect(result).toBeNull();
    });

    test('returns stored token from SecureStore', async () => {
      mockSecureStore.getItemAsync.mockResolvedValueOnce('ExponentPushToken[abc]');
      const result = await loadPushToken();
      expect(result).toBe('ExponentPushToken[abc]');
    });

    test('returns null on storage error', async () => {
      mockSecureStore.getItemAsync.mockRejectedValueOnce(new Error('storage error'));
      const result = await loadPushToken();
      expect(result).toBeNull();
    });
  });
});
