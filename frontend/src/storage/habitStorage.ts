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

/**
 * BUG-FRONTEND-INFRA-011 — when AsyncStorage hands us malformed JSON we used
 * to silently return ``null`` / ``[]``, masking both a parse failure and the
 * fact that future writes would keep appending to corrupt data. Now we log,
 * clear the poisoned key so subsequent launches self-heal, and let the
 * caller show a toast if the loss is user-visible.
 */
async function resetCorruptKey(key: string, err: unknown): Promise<void> {
  console.warn(`[storage] corrupt JSON in ${key}, clearing to self-heal`, err);
  try {
    await AsyncStorage.removeItem(key);
  } catch (removeErr) {
    console.warn(`[storage] failed to clear corrupt key ${key}`, removeErr);
  }
}

export async function saveHabits(habits: Habit[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(habits));
}

export async function loadHabits(): Promise<Habit[] | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Habit[];
    if (!Array.isArray(parsed)) {
      await resetCorruptKey(STORAGE_KEY, new Error('expected array'));
      return null;
    }
    return parsed.map(rehydrateHabit);
  } catch (err: unknown) {
    await resetCorruptKey(STORAGE_KEY, err);
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

/**
 * Replace the pending-check-in queue with `checkIns`. Used by the
 * partial-success replay path so a successful prefix is dropped without
 * a separate clear+rewrite (which would race with savePendingCheckIn).
 */
export async function replacePendingCheckIns(checkIns: PendingCheckIn[]): Promise<void> {
  await AsyncStorage.setItem(PENDING_CHECKINS_KEY, JSON.stringify(checkIns));
}

export async function loadPendingCheckIns(): Promise<PendingCheckIn[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_CHECKINS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as PendingCheckIn[];
    if (!Array.isArray(parsed)) {
      await resetCorruptKey(PENDING_CHECKINS_KEY, new Error('expected array'));
      return [];
    }
    return parsed;
  } catch (err: unknown) {
    await resetCorruptKey(PENDING_CHECKINS_KEY, err);
    return [];
  }
}

export async function clearPendingCheckIns(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_CHECKINS_KEY);
}
