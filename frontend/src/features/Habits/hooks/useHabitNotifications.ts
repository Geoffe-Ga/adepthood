import * as Notifications from 'expo-notifications';

import {
  saveNotificationIds,
  loadNotificationIds,
  clearNotificationIds,
  loadAllNotificationMappings,
  savePushToken,
  loadPushToken,
} from '../../../storage/notificationStorage';
import { DAYS_OF_WEEK } from '../constants';
import type { Habit } from '../Habits.types';

const MAX_REGISTRATION_RETRIES = 3;
const REGISTRATION_RETRY_DELAY_MS = 30_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const registerForPushNotificationsAsync = async (): Promise<string | undefined> => {
  const cached = await loadPushToken();
  if (cached) return cached;

  return attemptPushRegistration(0);
};

const attemptPushRegistration = async (attempt: number): Promise<string | undefined> => {
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
    await savePushToken(token);
    return token;
  } catch (error) {
    console.error(`Push registration attempt ${attempt + 1} failed:`, error);
    if (attempt < MAX_REGISTRATION_RETRIES - 1) {
      await wait(REGISTRATION_RETRY_DELAY_MS);
      return attemptPushRegistration(attempt + 1);
    }
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

  try {
    const persistedIds = await loadNotificationIds(habit.id);
    const idsToCancel =
      habit.notificationIds && habit.notificationIds.length > 0
        ? habit.notificationIds
        : persistedIds;

    if (idsToCancel.length > 0) {
      await Promise.all(
        idsToCancel.map((id) => Notifications.cancelScheduledNotificationAsync(id)),
      );
    }

    if (
      habit.notificationFrequency === 'off' ||
      !habit.notificationTimes ||
      habit.notificationTimes.length === 0
    ) {
      await clearNotificationIds(habit.id);
      return [];
    }

    const notificationIds = await scheduleNotificationsWithRetry(habit);
    await saveNotificationIds(habit.id, notificationIds);
    return notificationIds;
  } catch (error) {
    console.error(`Failed to update notifications for habit ${habit.id}:`, error);
    return [];
  }
};

const scheduleNotificationsWithRetry = async (habit: Habit): Promise<string[]> => {
  try {
    return await scheduleAllTimes(habit);
  } catch (firstError) {
    console.warn('Notification scheduling failed, retrying once:', firstError);
    try {
      return await scheduleAllTimes(habit);
    } catch (retryError) {
      console.error('Notification scheduling retry failed:', retryError);
      throw retryError;
    }
  }
};

const scheduleAllTimes = async (habit: Habit): Promise<string[]> => {
  const notificationIds: string[] = [];
  for (const notificationTime of habit.notificationTimes ?? []) {
    const ids = await scheduleHabitNotification(habit, notificationTime);
    notificationIds.push(...ids);
  }
  return notificationIds;
};

export const reconcileNotifications = async (): Promise<void> => {
  try {
    const persisted = await loadAllNotificationMappings();
    const allPersistedIds = new Set(Object.values(persisted).flat());
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const scheduledIds = new Set(scheduled.map((n) => n.identifier));

    // Cancel orphaned notifications (scheduled on device but not in our records)
    for (const notification of scheduled) {
      if (!allPersistedIds.has(notification.identifier)) {
        await Notifications.cancelScheduledNotificationAsync(notification.identifier);
      }
    }

    // Clean up persisted records whose notifications are no longer scheduled
    for (const [habitIdStr, ids] of Object.entries(persisted)) {
      const habitId = Number(habitIdStr);
      const stillScheduled = ids.filter((id) => scheduledIds.has(id));
      if (stillScheduled.length === 0) {
        await clearNotificationIds(habitId);
      } else if (stillScheduled.length !== ids.length) {
        await saveNotificationIds(habitId, stillScheduled);
      }
    }
  } catch (error) {
    console.error('Notification reconciliation failed:', error);
  }
};

export const cancelForHabit = async (habitId: number): Promise<void> => {
  try {
    const ids = await loadNotificationIds(habitId);
    await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id)));
    await clearNotificationIds(habitId);
  } catch (error) {
    console.error(`Failed to cancel notifications for habit ${habitId}:`, error);
  }
};

export const scheduleForHabit = async (habit: Habit): Promise<string[]> => {
  return updateHabitNotifications(habit);
};
