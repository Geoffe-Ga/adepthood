import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Habit } from '../features/Habits/Habits.types';

const STORAGE_KEY = '@adepthood/habits';
const PENDING_CHECKINS_KEY = '@adepthood/pending_checkins';

export interface PendingCheckIn {
  goal_id: number;
  did_complete: boolean;
  timestamp: string;
}

/**
 * Rehydrate Date fields that JSON.parse leaves as strings.
 */
function rehydrateHabit(raw: Habit): Habit {
  return {
    ...raw,
    start_date: new Date(raw.start_date),
    last_completion_date: raw.last_completion_date ? new Date(raw.last_completion_date) : undefined,
    completions: raw.completions?.map((c) => ({
      ...c,
      timestamp: new Date(c.timestamp),
    })),
  };
}

export async function saveHabits(habits: Habit[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(habits));
}

export async function loadHabits(): Promise<Habit[] | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: Habit[] = JSON.parse(raw);
    return parsed.map(rehydrateHabit);
  } catch {
    return null;
  }
}

export async function clearHabits(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export async function savePendingCheckIn(checkIn: PendingCheckIn): Promise<void> {
  const existing = await loadPendingCheckIns();
  existing.push(checkIn);
  await AsyncStorage.setItem(PENDING_CHECKINS_KEY, JSON.stringify(existing));
}

export async function loadPendingCheckIns(): Promise<PendingCheckIn[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_CHECKINS_KEY);
    if (raw === null) return [];
    return JSON.parse(raw) as PendingCheckIn[];
  } catch {
    return [];
  }
}

export async function clearPendingCheckIns(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_CHECKINS_KEY);
}
