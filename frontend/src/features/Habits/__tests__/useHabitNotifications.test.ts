import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import * as Notifications from 'expo-notifications';

import type { Habit } from '../Habits.types';
import {
  registerForPushNotificationsAsync,
  scheduleHabitNotification,
  updateHabitNotifications,
} from '../hooks/useHabitNotifications';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  SchedulableTriggerInputTypes: {
    DAILY: 'daily',
    WEEKLY: 'weekly',
  },
}));

const mockNotifications = Notifications as jest.Mocked<typeof Notifications>;

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
  it('returns token when permission is already granted', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({
      status: 'granted',
    } as never);
    mockNotifications.getExpoPushTokenAsync.mockResolvedValue({
      data: 'ExponentPushToken[abc123]',
    } as never);

    const token = await registerForPushNotificationsAsync();
    expect(token).toBe('ExponentPushToken[abc123]');
  });

  it('requests permission when not already granted', async () => {
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
  });

  it('cancels old notifications before scheduling new ones', async () => {
    const habit: Habit = {
      ...baseHabit,
      notificationIds: ['old-1', 'old-2'],
      notificationFrequency: 'daily',
      notificationTimes: ['08:00'],
    };

    await updateHabitNotifications(habit);
    expect(mockNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('old-1');
    expect(mockNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('old-2');
    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalled();
  });

  it('returns empty array when frequency is off', async () => {
    const habit: Habit = {
      ...baseHabit,
      notificationFrequency: 'off',
      notificationTimes: ['08:00'],
    };

    const ids = await updateHabitNotifications(habit);
    expect(ids).toEqual([]);
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
});
