import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = '@adepthood/notifications';

function keyFor(habitId: number): string {
  return `${KEY_PREFIX}/${habitId}`;
}

export async function saveNotificationIds(habitId: number, ids: string[]): Promise<void> {
  await AsyncStorage.setItem(keyFor(habitId), JSON.stringify(ids));
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
}
