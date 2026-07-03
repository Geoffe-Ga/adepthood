/* eslint-env jest */
/* global jest */
// Manual mock for the native ``expo-notifications`` module so any test that
// transitively imports the habit-notifications hook (e.g. via the habit
// manager pulled in by the journal habit tile) runs under Node without the
// package's untransformed ESM tripping the parser. Mirrors the other expo
// manual mocks in this directory; a test needing bespoke behavior still
// overrides these with a local ``jest.mock('expo-notifications', ...)``.
module.exports = {
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'token' })),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('notification-id')),
  cancelScheduledNotificationAsync: jest.fn(() => Promise.resolve()),
  getAllScheduledNotificationsAsync: jest.fn(() => Promise.resolve([])),
  SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly' },
};
