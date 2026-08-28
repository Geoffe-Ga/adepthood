import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Habit } from '../features/Habits/Habits.types';

import { getJsonArray, getJsonArrayForUpdate } from './jsonStore';
import { serialize } from './serializedWrite';

const STORAGE_KEY = '@adepthood/habits';
const PENDING_CHECKINS_KEY = '@adepthood/pending_checkins';
const DROPPED_CHECKINS_KEY = '@adepthood/dropped_checkins';

/**
 * Ceiling on the quarantine. The quarantine exists to tell the user that a
 * check-in was lost, not to be an audit log, so it keeps only the most recent
 * drops and evicts the oldest — an unbounded list would grow forever on a
 * device whose queue keeps hitting the same rejection.
 */
export const MAX_DROPPED_CHECK_INS = 20;

export interface PendingCheckIn {
  goal_id: number;
  did_complete: boolean;
  timestamp: string;
  /** Explicit backfill day for a backdated log; replay forwards it verbatim. */
  completed_on?: string;
}

/** A queued check-in the replay gave up on, plus why and when it was dropped. */
export interface DroppedCheckIn {
  goal_id: number;
  did_complete: boolean;
  timestamp: string;
  /** Explicit backfill day carried over from the queued entry, if it had one. */
  completed_on?: string;
  /** Status of the response that made the entry permanently unpostable. */
  status: number;
  /** ISO instant the replay dropped the entry. */
  dropped_at: string;
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
 * two concurrent appenders that both read the queue before
 * either calls `setItem` would each write a single-item array,
 * silently losing one of the user's check-ins. Funnelling every write
 * to `PENDING_CHECKINS_KEY` through `serialize(...)` makes the
 * load-modify-write block atomic with respect to other appenders.
 */
export async function savePendingCheckIn(checkIn: PendingCheckIn): Promise<void> {
  await serialize(PENDING_CHECKINS_KEY, async () => {
    let result: PendingCheckIn[] | null;
    try {
      result = await getJsonArrayForUpdate<PendingCheckIn>(PENDING_CHECKINS_KEY);
    } catch (err: unknown) {
      // A transient read must abort the write; falling back to [] here would
      // overwrite an intact on-disk queue with a single-item array.
      console.warn(
        '[storage] transient read during pending check-in append, aborting write to preserve queue',
        err,
      );
      return;
    }
    const existing = result ?? [];
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

/**
 * Append `entry` to the quarantine, keeping only the newest
 * `MAX_DROPPED_CHECK_INS` records. Runs inside the serialized lane, so the
 * read-modify-write is atomic with respect to the other quarantine writers.
 */
async function appendDroppedCheckIn(entry: DroppedCheckIn): Promise<void> {
  let result: DroppedCheckIn[] | null;
  try {
    result = await getJsonArrayForUpdate<DroppedCheckIn>(DROPPED_CHECKINS_KEY);
  } catch (err: unknown) {
    // Same rule as the pending queue: a transient read aborts the write.
    // Falling back to [] would replace an intact quarantine with one record,
    // erasing the very losses the quarantine exists to report.
    console.warn(
      '[storage] transient read during dropped check-in append, aborting write to preserve quarantine',
      err,
    );
    return;
  }
  const existing = result ?? [];
  existing.push(entry);
  // Oldest-first storage, so trimming from the front evicts the oldest.
  await AsyncStorage.setItem(
    DROPPED_CHECKINS_KEY,
    JSON.stringify(existing.slice(-MAX_DROPPED_CHECK_INS)),
  );
}

/**
 * Quarantine a check-in the replay dropped because retrying it is futile, so
 * the loss has a durable record instead of only a console warning the user
 * will never see.
 *
 * Total by construction: the caller is the replay loop's own catch block, and
 * a rejection there would propagate out of ``loadHabits`` and abandon the rest
 * of the drain. ``serialize`` deliberately forwards the lambda's rejection to
 * its caller, so the write is wrapped here rather than left to the lane.
 */
export async function recordDroppedCheckIn(entry: DroppedCheckIn): Promise<void> {
  try {
    await serialize(DROPPED_CHECKINS_KEY, () => appendDroppedCheckIn(entry));
  } catch (err: unknown) {
    console.warn('[storage] could not quarantine a dropped check-in', err);
  }
}

/** Read the quarantine; an absent or unreadable key reads as "nothing lost". */
export async function loadDroppedCheckIns(): Promise<DroppedCheckIn[]> {
  return (await getJsonArray<DroppedCheckIn>(DROPPED_CHECKINS_KEY)) ?? [];
}

/**
 * Drop the quarantine — the user dismissed the notice, or logout is wiping the
 * device. Routed through the same serialized lane as `recordDroppedCheckIn` so
 * a clear cannot interleave with an inflight append and resurrect the record
 * it was supposed to remove (see `clearPendingCheckIns`).
 */
export async function clearDroppedCheckIns(): Promise<void> {
  await serialize(DROPPED_CHECKINS_KEY, () => AsyncStorage.removeItem(DROPPED_CHECKINS_KEY));
}
