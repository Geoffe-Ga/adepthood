import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = '@adepthood/notifications';
// expo-secure-store only allows alphanumerics plus `.`, `-`, `_` in keys,
// so this one cannot share the `@adepthood/...` prefix with AsyncStorage keys.
const PUSH_TOKEN_KEY = 'adepthood_push_token';
const ALL_HABIT_IDS_KEY = '@adepthood/notification_habit_ids';

function keyFor(habitId: number): string {
  return `${KEY_PREFIX}/${habitId}`;
}

/**
 * BUG-FRONTEND-INFRA-011 — self-heal when AsyncStorage returns malformed JSON.
 */
async function resetCorruptKey(key: string, err: unknown): Promise<void> {
  console.warn(`[storage] corrupt JSON in ${key}, clearing to self-heal`, err);
  try {
    await AsyncStorage.removeItem(key);
  } catch (removeErr) {
    console.warn(`[storage] failed to clear corrupt key ${key}`, removeErr);
  }
}

export async function saveNotificationIds(habitId: number, ids: string[]): Promise<void> {
  await AsyncStorage.setItem(keyFor(habitId), JSON.stringify(ids));
  await trackHabitId(habitId);
}

export async function loadNotificationIds(habitId: number): Promise<string[]> {
  const key = keyFor(habitId);
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      await resetCorruptKey(key, new Error('expected array'));
      return [];
    }
    return parsed as string[];
  } catch (err: unknown) {
    await resetCorruptKey(key, err);
    return [];
  }
}

export async function clearNotificationIds(habitId: number): Promise<void> {
  await AsyncStorage.removeItem(keyFor(habitId));
  await untrackHabitId(habitId);
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
  try {
    const raw = await AsyncStorage.getItem(ALL_HABIT_IDS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      await resetCorruptKey(ALL_HABIT_IDS_KEY, new Error('expected array'));
      return [];
    }
    return parsed as number[];
  } catch (err: unknown) {
    await resetCorruptKey(ALL_HABIT_IDS_KEY, err);
    return [];
  }
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
