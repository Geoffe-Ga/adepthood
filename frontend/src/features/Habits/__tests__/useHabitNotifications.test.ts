import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import * as Notifications from 'expo-notifications';

import * as notifStorage from '../../../storage/notificationStorage';
import type { Habit } from '../Habits.types';
import {
  registerForPushNotificationsAsync,
  scheduleHabitNotification,
  updateHabitNotifications,
  reconcileNotifications,
  cancelForHabit,
} from '../hooks/useHabitNotifications';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  getAllScheduledNotificationsAsync: jest.fn(),
  SchedulableTriggerInputTypes: {
    DAILY: 'daily',
    WEEKLY: 'weekly',
  },
}));

jest.mock('../../../storage/notificationStorage', () => ({
  saveNotificationIds: jest.fn(() => Promise.resolve()),
  loadNotificationIds: jest.fn(() => Promise.resolve([])),
  clearNotificationIds: jest.fn(() => Promise.resolve()),
  loadAllNotificationMappings: jest.fn(() => Promise.resolve({})),
  savePushToken: jest.fn(() => Promise.resolve()),
  loadPushToken: jest.fn(() => Promise.resolve(null)),
}));

const mockNotifications = Notifications as jest.Mocked<typeof Notifications>;
const mockStorage = notifStorage as jest.Mocked<typeof notifStorage>;

const baseHabit: Habit = {
  id: 1,
  stage: 'Beige',
  name: 'Meditate',
  icon: '🧘',
  streak: 5,
  energy_cost: 1,
  energy_return: 3,
  start_date: new Date(),
  goals: [],
};

describe('registerForPushNotificationsAsync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns cached token when available', async () => {
    mockStorage.loadPushToken.mockResolvedValue('ExponentPushToken[cached]');

    const token = await registerForPushNotificationsAsync();
    expect(token).toBe('ExponentPushToken[cached]');
    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it('returns token when permission is already granted', async () => {
    mockStorage.loadPushToken.mockResolvedValue(null);
    mockNotifications.getPermissionsAsync.mockResolvedValue({
      status: 'granted',
    } as never);
    mockNotifications.getExpoPushTokenAsync.mockResolvedValue({
      data: 'ExponentPushToken[abc123]',
    } as never);

    const token = await registerForPushNotificationsAsync();
    expect(token).toBe('ExponentPushToken[abc123]');
    expect(mockStorage.savePushToken).toHaveBeenCalledWith('ExponentPushToken[abc123]');
  });

  it('requests permission when not already granted', async () => {
    mockStorage.loadPushToken.mockResolvedValue(null);
    mockNotifications.getPermissionsAsync.mockResolvedValue({
      status: 'undetermined',
    } as never);
    mockNotifications.requestPermissionsAsync.mockResolvedValue({
      status: 'granted',
    } as never);
    mockNotifications.getExpoPushTokenAsync.mockResolvedValue({
      data: 'ExponentPushToken[xyz]',
    } as never);

    const token = await registerForPushNotificationsAsync();
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalled();
    expect(token).toBe('ExponentPushToken[xyz]');
  });

  it('returns undefined when permission denied', async () => {
    mockStorage.loadPushToken.mockResolvedValue(null);
    mockNotifications.getPermissionsAsync.mockResolvedValue({
      status: 'denied',
    } as never);
    mockNotifications.requestPermissionsAsync.mockResolvedValue({
      status: 'denied',
    } as never);

    const token = await registerForPushNotificationsAsync();
    expect(token).toBeUndefined();
  });
});

describe('scheduleHabitNotification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifications.scheduleNotificationAsync.mockResolvedValue('notif-id-1');
  });

  it('schedules a daily notification for daily frequency', async () => {
    const habit: Habit = { ...baseHabit, notificationFrequency: 'daily' };
    const ids = await scheduleHabitNotification(habit, '08:30');
    expect(ids).toEqual(['notif-id-1']);
    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ title: 'Time for: Meditate' }),
        trigger: expect.objectContaining({ type: 'daily', hour: 8, minute: 30 }),
      }),
    );
  });

  it('schedules a weekly notification for weekly frequency', async () => {
    const habit: Habit = { ...baseHabit, notificationFrequency: 'weekly' };
    const ids = await scheduleHabitNotification(habit, '09:00');
    expect(ids).toEqual(['notif-id-1']);
    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ type: 'weekly', weekday: 1 }),
      }),
    );
  });

  it('schedules multiple notifications for custom frequency', async () => {
    let callCount = 0;
    mockNotifications.scheduleNotificationAsync.mockImplementation(async () => {
      callCount += 1;
      return `notif-${callCount}`;
    });

    const habit: Habit = {
      ...baseHabit,
      notificationFrequency: 'custom',
      notificationDays: ['Monday', 'Wednesday', 'Friday'],
    };
    const ids = await scheduleHabitNotification(habit, '07:00');
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(['notif-1', 'notif-2', 'notif-3']);
  });
});

describe('updateHabitNotifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifications.scheduleNotificationAsync.mockResolvedValue('new-notif-id');
    mockNotifications.cancelScheduledNotificationAsync.mockResolvedValue(undefined as never);
    mockStorage.loadNotificationIds.mockResolvedValue([]);
  });

  it('cancels old notifications from persistence before scheduling new ones', async () => {
    mockStorage.loadNotificationIds.mockResolvedValue(['persisted-1', 'persisted-2']);

    const habit: Habit = {
      ...baseHabit,
      notificationFrequency: 'daily',
      notificationTimes: ['08:00'],
    };

    await updateHabitNotifications(habit);
    expect(mockNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('persisted-1');
    expect(mockNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('persisted-2');
    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalled();
  });

  it('prefers in-memory notificationIds over persisted when available', async () => {
    mockStorage.loadNotificationIds.mockResolvedValue(['persisted-1']);

    const habit: Habit = {
      ...baseHabit,
      notificationIds: ['memory-1', 'memory-2'],
      notificationFrequency: 'daily',
      notificationTimes: ['08:00'],
    };

    await updateHabitNotifications(habit);
    expect(mockNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('memory-1');
    expect(mockNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('memory-2');
    expect(mockNotifications.cancelScheduledNotificationAsync).not.toHaveBeenCalledWith(
      'persisted-1',
    );
  });

  it('persists new notification IDs after scheduling', async () => {
    const habit: Habit = {
      ...baseHabit,
      notificationFrequency: 'daily',
      notificationTimes: ['08:00'],
    };

    await updateHabitNotifications(habit);
    expect(mockStorage.saveNotificationIds).toHaveBeenCalledWith(1, ['new-notif-id']);
  });

  it('clears persisted IDs when frequency is off', async () => {
    const habit: Habit = {
      ...baseHabit,
      notificationFrequency: 'off',
      notificationTimes: ['08:00'],
    };

    const ids = await updateHabitNotifications(habit);
    expect(ids).toEqual([]);
    expect(mockStorage.clearNotificationIds).toHaveBeenCalledWith(1);
  });

  it('returns empty array when no notification times', async () => {
    const habit: Habit = {
      ...baseHabit,
      notificationFrequency: 'daily',
      notificationTimes: [],
    };

    const ids = await updateHabitNotifications(habit);
    expect(ids).toEqual([]);
  });

  it('returns empty array when habit has no id', async () => {
    const habit = { ...baseHabit, id: 0 } as Habit;
    const ids = await updateHabitNotifications(habit);
    expect(ids).toEqual([]);
  });

  it('returns empty array on scheduling error without crashing', async () => {
    mockNotifications.scheduleNotificationAsync.mockRejectedValue(new Error('scheduling failed'));

    const habit: Habit = {
      ...baseHabit,
      notificationFrequency: 'daily',
      notificationTimes: ['08:00'],
    };

    const ids = await updateHabitNotifications(habit);
    expect(ids).toEqual([]);
  });
});

describe('reconcileNotifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifications.cancelScheduledNotificationAsync.mockResolvedValue(undefined as never);
  });

  it('cancels orphaned notifications not in persisted records', async () => {
    mockStorage.loadAllNotificationMappings.mockResolvedValue({ 1: ['a'] });
    mockNotifications.getAllScheduledNotificationsAsync.mockResolvedValue([
      { identifier: 'a' } as never,
      { identifier: 'orphan-1' } as never,
    ]);

    await reconcileNotifications();
    expect(mockNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('orphan-1');
    expect(mockNotifications.cancelScheduledNotificationAsync).not.toHaveBeenCalledWith('a');
  });

  it('cleans up persisted records for notifications no longer scheduled', async () => {
    mockStorage.loadAllNotificationMappings.mockResolvedValue({ 1: ['a', 'b'] });
    mockNotifications.getAllScheduledNotificationsAsync.mockResolvedValue([
      { identifier: 'a' } as never,
    ]);

    await reconcileNotifications();
    expect(mockStorage.saveNotificationIds).toHaveBeenCalledWith(1, ['a']);
  });

  it('clears habit entry entirely when none of its notifications are scheduled', async () => {
    mockStorage.loadAllNotificationMappings.mockResolvedValue({ 1: ['gone-1', 'gone-2'] });
    mockNotifications.getAllScheduledNotificationsAsync.mockResolvedValue([]);

    await reconcileNotifications();
    expect(mockStorage.clearNotificationIds).toHaveBeenCalledWith(1);
  });

  it('does nothing when everything is in sync', async () => {
    mockStorage.loadAllNotificationMappings.mockResolvedValue({ 1: ['a'] });
    mockNotifications.getAllScheduledNotificationsAsync.mockResolvedValue([
      { identifier: 'a' } as never,
    ]);

    await reconcileNotifications();
    expect(mockNotifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(mockStorage.saveNotificationIds).not.toHaveBeenCalled();
    expect(mockStorage.clearNotificationIds).not.toHaveBeenCalled();
  });

  it('handles errors gracefully without crashing', async () => {
    mockStorage.loadAllNotificationMappings.mockRejectedValue(new Error('storage error'));

    await expect(reconcileNotifications()).resolves.toBeUndefined();
  });
});

describe('cancelForHabit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifications.cancelScheduledNotificationAsync.mockResolvedValue(undefined as never);
  });

  it('cancels all persisted notifications and clears storage', async () => {
    mockStorage.loadNotificationIds.mockResolvedValue(['id-1', 'id-2']);

    await cancelForHabit(42);
    expect(mockNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('id-1');
    expect(mockNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('id-2');
    expect(mockStorage.clearNotificationIds).toHaveBeenCalledWith(42);
  });

  it('handles errors gracefully', async () => {
    mockStorage.loadNotificationIds.mockRejectedValue(new Error('storage error'));
    await expect(cancelForHabit(42)).resolves.toBeUndefined();
  });
});
