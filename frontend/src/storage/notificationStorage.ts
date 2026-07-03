import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { getJsonArray } from './jsonStore';

const KEY_PREFIX = '@adepthood/notifications';
// expo-secure-store only allows alphanumerics plus `.`, `-`, `_` in keys,
// so this one cannot share the `@adepthood/...` prefix with AsyncStorage keys.
const PUSH_TOKEN_KEY = 'adepthood_push_token';
const ALL_HABIT_IDS_KEY = '@adepthood/notification_habit_ids';

function keyFor(habitId: number): string {
  return `${KEY_PREFIX}/${habitId}`;
}

export async function saveNotificationIds(habitId: number, ids: string[]): Promise<void> {
  await AsyncStorage.setItem(keyFor(habitId), JSON.stringify(ids));
  await trackHabitId(habitId);
}

export async function loadNotificationIds(habitId: number): Promise<string[]> {
  return (await getJsonArray<string>(keyFor(habitId))) ?? [];
}

export async function clearNotificationIds(habitId: number): Promise<void> {
  await AsyncStorage.removeItem(keyFor(habitId));
  await untrackHabitId(habitId);
}

/**
 * BUG-FE-STATE-001 — remove every per-user notification key on logout so
 * the next user on the device does not inherit scheduled notifications or
 * the tracking list that points at them. The push-token key is intentionally
 * NOT cleared: it is a device credential, not a user credential.
 */
export async function clearAllNotificationData(): Promise<void> {
  const habitIds = await loadTrackedHabitIds();
  for (const habitId of habitIds) {
    await AsyncStorage.removeItem(keyFor(habitId));
  }
  await AsyncStorage.removeItem(ALL_HABIT_IDS_KEY);
}

export async function loadAllNotificationMappings(): Promise<Record<number, string[]>> {
  const habitIds = await loadTrackedHabitIds();
  const mappings: Record<number, string[]> = {};
  for (const habitId of habitIds) {
    const ids = await loadNotificationIds(habitId);
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
  } catch (err: unknown) {
    console.warn('[storage] SecureStore push-token load failed', err);
    return null;
  }
}

async function loadTrackedHabitIds(): Promise<number[]> {
  return (await getJsonArray<number>(ALL_HABIT_IDS_KEY)) ?? [];
}

async function trackHabitId(habitId: number): Promise<void> {
  const ids = await loadTrackedHabitIds();
  if (!ids.includes(habitId)) {
    ids.push(habitId);
    await AsyncStorage.setItem(ALL_HABIT_IDS_KEY, JSON.stringify(ids));
  }
}

async function untrackHabitId(habitId: number): Promise<void> {
  const ids = await loadTrackedHabitIds();
  const filtered = ids.filter((id) => id !== habitId);
  await AsyncStorage.setItem(ALL_HABIT_IDS_KEY, JSON.stringify(filtered));
}
