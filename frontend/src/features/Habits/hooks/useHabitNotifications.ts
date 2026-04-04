import * as Notifications from 'expo-notifications';

import { DAYS_OF_WEEK } from '../constants';
import type { Habit } from '../Habits.types';

export const registerForPushNotificationsAsync = async (): Promise<string | undefined> => {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      return undefined;
    }
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    return token;
  } catch (error) {
    console.error('Failed to get push token:', error);
    return undefined;
  }
};

export const scheduleHabitNotification = async (
  habit: Habit,
  notificationTime: string,
): Promise<string[]> => {
  const [hours = 0, minutes = 0] = notificationTime.split(':').map(Number);

  const schedule = async (trigger: Notifications.NotificationTriggerInput): Promise<string> => {
    return Notifications.scheduleNotificationAsync({
      content: {
        title: `Time for: ${habit.name}`,
        body: `Continue your ${habit.streak}-day streak! 💪`,
        data: { habitId: habit.id },
      },
      trigger,
    });
  };

  if (habit.notificationFrequency === 'daily') {
    const dailyTrigger: Notifications.DailyTriggerInput = {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: hours,
      minute: minutes,
    };
    return [await schedule(dailyTrigger)];
  }

  if (habit.notificationFrequency === 'weekly') {
    const weeklyTrigger: Notifications.WeeklyTriggerInput = {
      type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
      weekday: 1,
      hour: hours,
      minute: minutes,
    };
    return [await schedule(weeklyTrigger)];
  }

  if (
    habit.notificationFrequency === 'custom' &&
    habit.notificationDays &&
    habit.notificationDays.length > 0
  ) {
    const notificationIds: string[] = [];
    for (const day of habit.notificationDays) {
      const weekday = DAYS_OF_WEEK.indexOf(day) + 1;
      const customTrigger: Notifications.WeeklyTriggerInput = {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday,
        hour: hours,
        minute: minutes,
      };
      const id = await schedule(customTrigger);
      notificationIds.push(id);
    }
    return notificationIds;
  }

  const fallbackTrigger: Notifications.DailyTriggerInput = {
    type: Notifications.SchedulableTriggerInputTypes.DAILY,
    hour: hours,
    minute: minutes,
  };
  return [await schedule(fallbackTrigger)];
};

export const updateHabitNotifications = async (habit: Habit): Promise<string[]> => {
  if (!habit.id) return [];
  if (habit.notificationIds && habit.notificationIds.length > 0) {
    await Promise.all(
      habit.notificationIds.map((id) => Notifications.cancelScheduledNotificationAsync(id)),
    );
  }

  if (
    habit.notificationFrequency === 'off' ||
    !habit.notificationTimes ||
    habit.notificationTimes.length === 0
  ) {
    return [];
  }

  const notificationIds: string[] = [];
  for (const notificationTime of habit.notificationTimes) {
    const ids = await scheduleHabitNotification(habit, notificationTime);
    notificationIds.push(...ids);
  }
  return notificationIds;
};
