import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { getJsonArray } from './jsonStore';
import { scopedKey } from './userScope';

import { reportDiagnostic } from '@/observability/diagnostics';

const KEY_PREFIX = '@adepthood/notifications';
// expo-secure-store only allows alphanumerics plus `.`, `-`, `_` in keys,
// so this one cannot share the `@adepthood/...` prefix with AsyncStorage keys.
const PUSH_TOKEN_KEY = 'adepthood_push_token';
const ALL_HABIT_IDS_KEY_BASE = '@adepthood/notification_habit_ids';

/**
 * Scheduled-notification bookkeeping is per-account (habit ids only mean
 * something inside one account), so both keys resolve through ``scopedKey``.
 * BUG-FE-STATE-001: the incoming user on a device that changed hands reads
 * their own namespace, never the previous owner's schedule.
 *
 * #3334: each operation resolves that namespace ONCE, when it begins, and
 * keeps it across its own awaits. ``saveNotificationIds`` writes the mapping,
 * reads the tracking list and writes it back; resolving the key at each step
 * let an account switch between them put the tail of account A's write into
 * account B's list. A caller spanning several operations (the reminder
 * reschedule) captures one namespace and passes it to each.
 */
export interface NotificationNamespace {
  /** What ``scopedKey`` appended for the account live at capture. */
  readonly suffix: string;
}

/** Bind the account namespace live right now, for use across later awaits. */
export function captureNotificationNamespace(): NotificationNamespace {
  return { suffix: scopedKey('') };
}

function keyFor(habitId: number, namespace: NotificationNamespace): string {
  return `${KEY_PREFIX}/${habitId}${namespace.suffix}`;
}

/** This account's list of habits that currently have notifications scheduled. */
function allHabitIdsKey(namespace: NotificationNamespace): string {
  return `${ALL_HABIT_IDS_KEY_BASE}${namespace.suffix}`;
}

export async function saveNotificationIds(
  habitId: number,
  ids: string[],
  namespace: NotificationNamespace = captureNotificationNamespace(),
): Promise<void> {
  await AsyncStorage.setItem(keyFor(habitId, namespace), JSON.stringify(ids));
  await trackHabitId(habitId, namespace);
}

export async function loadNotificationIds(
  habitId: number,
  namespace: NotificationNamespace = captureNotificationNamespace(),
): Promise<string[]> {
  return (await getJsonArray<string>(keyFor(habitId, namespace))) ?? [];
}

export async function clearNotificationIds(
  habitId: number,
  namespace: NotificationNamespace = captureNotificationNamespace(),
): Promise<void> {
  await AsyncStorage.removeItem(keyFor(habitId, namespace));
  await untrackHabitId(habitId, namespace);
}

/**
 * Stop every reminder scheduled on this device (#3334).
 *
 * Every local notification this app schedules is a Habit reminder, and they
 * all belong to the account whose cleanup is running: no new account can
 * schedule until that cleanup commits its scope. Cancelling the whole native
 * inventory, rather than only the ids this account recorded, also stops a
 * reminder whose bookkeeping never landed. Web has no native scheduler, so
 * there is nothing to cancel there. A native failure is reported and does not
 * hold back the record clears: the next session's start-up reconcile cancels
 * any reminder the records no longer name.
 */
async function cancelAllNativeReminders(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    reportDiagnostic('notification_cancel_failed');
  }
}

/**
 * BUG-FE-STATE-001 — remove every per-user notification key on logout so
 * the next user on the device does not inherit scheduled notifications or
 * the tracking list that points at them, and (#3334) cancel the reminders
 * themselves, which deleting the records alone left firing. The push-token
 * key is intentionally NOT cleared: it is a device credential, not a user
 * credential.
 */
export async function clearAllNotificationData(): Promise<void> {
  const namespace = captureNotificationNamespace();
  await cancelAllNativeReminders();
  const habitIds = await loadTrackedHabitIds(namespace);
  for (const habitId of habitIds) {
    await AsyncStorage.removeItem(keyFor(habitId, namespace));
  }
  await AsyncStorage.removeItem(allHabitIdsKey(namespace));
}

export async function loadAllNotificationMappings(
  namespace: NotificationNamespace = captureNotificationNamespace(),
): Promise<Record<number, string[]>> {
  const habitIds = await loadTrackedHabitIds(namespace);
  const mappings: Record<number, string[]> = {};
  for (const habitId of habitIds) {
    const ids = await loadNotificationIds(habitId, namespace);
    if (ids.length > 0) {
      mappings[habitId] = ids;
    }
  }
  return mappings;
}

export async function savePushToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
}

export async function loadPushToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  } catch {
    reportDiagnostic('storage_read_failed', { storage: 'notifications' });
    return null;
  }
}

async function loadTrackedHabitIds(namespace: NotificationNamespace): Promise<number[]> {
  return (await getJsonArray<number>(allHabitIdsKey(namespace))) ?? [];
}

async function trackHabitId(habitId: number, namespace: NotificationNamespace): Promise<void> {
  const ids = await loadTrackedHabitIds(namespace);
  if (!ids.includes(habitId)) {
    ids.push(habitId);
    await AsyncStorage.setItem(allHabitIdsKey(namespace), JSON.stringify(ids));
  }
}

async function untrackHabitId(habitId: number, namespace: NotificationNamespace): Promise<void> {
  const ids = await loadTrackedHabitIds(namespace);
  const filtered = ids.filter((id) => id !== habitId);
  await AsyncStorage.setItem(allHabitIdsKey(namespace), JSON.stringify(filtered));
}
