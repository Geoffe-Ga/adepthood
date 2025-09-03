/* eslint-env jest */

import { jest, describe, it, expect } from '@jest/globals';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { registerForPushNotificationsAsync } from '../notifications';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(),
}));

describe('registerForPushNotificationsAsync', () => {
  it('returns undefined on web without vapid key', async () => {
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const token = await registerForPushNotificationsAsync();

    expect(token).toBeUndefined();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
    warnSpy.mockRestore();
  });
});
