import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Habit } from '../features/Habits/Habits.types';

import { getJsonArray } from './jsonStore';
import { serialize } from './serializedWrite';

const STORAGE_KEY = '@adepthood/habits';
const PENDING_CHECKINS_KEY = '@adepthood/pending_checkins';

export interface PendingCheckIn {
  goal_id: number;
  did_complete: boolean;
  timestamp: string;
  /** Explicit backfill day for a backdated log; replay forwards it verbatim. */
  completed_on?: string;
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
  const parsed = await getJsonArray<Habit>(STORAGE_KEY);
  if (parsed === null) return null;
  return parsed.map(rehydrateHabit);
}

export async function clearHabits(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

/**
 * BUG-FE-STORAGE-002: append a check-in to the pending queue under a
 * serialized write lane. AsyncStorage offers no transactional RMW, so
 * two concurrent appenders that both hit `loadPendingCheckIns` before
 * either calls `setItem` would each write a single-item array,
 * silently losing one of the user's check-ins. Funnelling every write
 * to `PENDING_CHECKINS_KEY` through `serialize(...)` makes the
 * load-modify-write block atomic with respect to other appenders.
 */
export async function savePendingCheckIn(checkIn: PendingCheckIn): Promise<void> {
  await serialize(PENDING_CHECKINS_KEY, async () => {
    const existing = await loadPendingCheckIns();
    existing.push(checkIn);
    await AsyncStorage.setItem(PENDING_CHECKINS_KEY, JSON.stringify(existing));
  });
}

/**
 * Replace the pending-check-in queue with `checkIns`. Used by the
 * partial-success replay path so a successful prefix is dropped without
 * a separate clear+rewrite (which would race with savePendingCheckIn).
 * Serialized through the same lane so a replay-driven `replace` can't
 * race with an inflight `savePendingCheckIn` from the foreground.
 */
export async function replacePendingCheckIns(checkIns: PendingCheckIn[]): Promise<void> {
  await serialize(PENDING_CHECKINS_KEY, async () => {
    await AsyncStorage.setItem(PENDING_CHECKINS_KEY, JSON.stringify(checkIns));
  });
}

export async function loadPendingCheckIns(): Promise<PendingCheckIn[]> {
  return (await getJsonArray<PendingCheckIn>(PENDING_CHECKINS_KEY)) ?? [];
}

/**
 * Drop the pending-check-in queue. Routed through the same serialized
 * lane as `savePendingCheckIn` and `replacePendingCheckIns` so a clear
 * cannot interleave with an inflight save: a queued save lambda would
 * otherwise read its existing items, race past a clear that ran
 * outside the lane, and re-write the items the clear was supposed to
 * drop — silently resurrecting check-ins.
 */
export async function clearPendingCheckIns(): Promise<void> {
  await serialize(PENDING_CHECKINS_KEY, () => AsyncStorage.removeItem(PENDING_CHECKINS_KEY));
}
