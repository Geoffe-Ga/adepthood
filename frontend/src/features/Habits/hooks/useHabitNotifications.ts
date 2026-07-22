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

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted ?? false;

// Cancelable delay: aborting resolves immediately and clears the pending timer.
const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (isAborted(signal)) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const registerForPushNotificationsAsync = async (
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const cached = await loadPushToken();
  if (cached) return cached;

  return attemptPushRegistration(0, signal);
};

const attemptPushRegistration = async (
  attempt: number,
  signal?: AbortSignal,
): Promise<string | undefined> => {
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
      return retryAfterDelay(attempt, signal);
    }
    return undefined;
  }
};

const retryAfterDelay = async (
  attempt: number,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  if (isAborted(signal)) return undefined;
  await wait(REGISTRATION_RETRY_DELAY_MS, signal);
  if (isAborted(signal)) return undefined;
  return attemptPushRegistration(attempt + 1, signal);
};

const buildDailyTrigger = (hours: number, minutes: number): Notifications.DailyTriggerInput => ({
  type: Notifications.SchedulableTriggerInputTypes.DAILY,
  hour: hours,
  minute: minutes,
});

const buildWeeklyTrigger = (
  weekday: number,
  hours: number,
  minutes: number,
): Notifications.WeeklyTriggerInput => ({
  type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
  weekday,
  hour: hours,
  minute: minutes,
});

const scheduleOne = async (
  habit: Habit,
  trigger: Notifications.NotificationTriggerInput,
): Promise<string> =>
  Notifications.scheduleNotificationAsync({
    content: {
      title: `Time for: ${habit.name}`,
      body: `Continue your ${habit.streak}-day streak! 💪`,
      data: { habitId: habit.id },
    },
    trigger,
  });

const scheduleCustomDays = async (
  habit: Habit,
  hours: number,
  minutes: number,
): Promise<string[]> => {
  const ids: string[] = [];
  for (const day of habit.notificationDays ?? []) {
    const weekday = DAYS_OF_WEEK.indexOf(day) + 1;
    ids.push(await scheduleOne(habit, buildWeeklyTrigger(weekday, hours, minutes)));
  }
  return ids;
};

export const scheduleHabitNotification = async (
  habit: Habit,
  notificationTime: string,
): Promise<string[]> => {
  const [hours = 0, minutes = 0] = notificationTime.split(':').map(Number);

  if (habit.notificationFrequency === 'daily') {
    return [await scheduleOne(habit, buildDailyTrigger(hours, minutes))];
  }
  if (habit.notificationFrequency === 'weekly') {
    return [await scheduleOne(habit, buildWeeklyTrigger(1, hours, minutes))];
  }
  const hasCustomDays =
    habit.notificationFrequency === 'custom' &&
    habit.notificationDays &&
    habit.notificationDays.length > 0;
  if (hasCustomDays) {
    return scheduleCustomDays(habit, hours, minutes);
  }
  return [await scheduleOne(habit, buildDailyTrigger(hours, minutes))];
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
  }
  // Single retry outside the first catch to avoid nested try/catch
  try {
    return await scheduleAllTimes(habit);
  } catch (retryError) {
    console.error('Notification scheduling retry failed:', retryError);
    throw retryError;
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

export const reconcileNotifications = async (signal?: AbortSignal): Promise<void> => {
  try {
    if (isAborted(signal)) return;
    const persisted = await loadAllNotificationMappings();
    const allPersistedIds = new Set(Object.values(persisted).flat());
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    // Abort mid-flight (e.g. unmount) must not cancel or rewrite anything.
    if (isAborted(signal)) return;
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
