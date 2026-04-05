import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = '@adepthood/notifications';
const PUSH_TOKEN_KEY = '@adepthood/push_token';
const ALL_HABIT_IDS_KEY = '@adepthood/notification_habit_ids';

function keyFor(habitId: number): string {
  return `${KEY_PREFIX}/${habitId}`;
}

export async function saveNotificationIds(habitId: number, ids: string[]): Promise<void> {
  await AsyncStorage.setItem(keyFor(habitId), JSON.stringify(ids));
  await trackHabitId(habitId);
}

export async function loadNotificationIds(habitId: number): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(habitId));
    if (raw === null) return [];
    return JSON.parse(raw);
  } catch {
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
  await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
}

export async function loadPushToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PUSH_TOKEN_KEY);
  } catch {
    return null;
  }
}

async function loadTrackedHabitIds(): Promise<number[]> {
  try {
    const raw = await AsyncStorage.getItem(ALL_HABIT_IDS_KEY);
    if (raw === null) return [];
    return JSON.parse(raw);
  } catch {
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
