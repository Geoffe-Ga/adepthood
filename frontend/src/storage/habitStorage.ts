import AsyncStorage from '@react-native-async-storage/async-storage';
import { v4 as uuidv4 } from 'uuid';

import type { Habit } from '../features/Habits/Habits.types';

import { getJsonArray, getJsonArrayForUpdate } from './jsonStore';
import { serialize } from './serializedWrite';
import { getActiveUser, getActiveUserGeneration, scopedKey } from './userScope';

import { reportDiagnostic } from '@/observability/diagnostics';

/**
 * The three caches below are per-account, so every one of them is resolved
 * through ``scopedKey`` at call time rather than frozen into a module
 * constant. BUG-FE-STATE-001: on a device that changes hands the incoming
 * session reads its own namespace, so an account switch that somehow skipped
 * the wipe still cannot show one user another's habits, unsent check-ins, or
 * quarantine.
 */
const HABITS_KEY_BASE = '@adepthood/habits';
const PENDING_CHECKINS_KEY_BASE = '@adepthood/pending_checkins';
const DROPPED_CHECKINS_KEY_BASE = '@adepthood/dropped_checkins';

/** This account's habit cache key. */
function habitsKey(): string {
  return scopedKey(HABITS_KEY_BASE);
}

/** This account's pending-check-in queue key — also its serialized write lane. */
function pendingCheckInsKey(): string {
  return scopedKey(PENDING_CHECKINS_KEY_BASE);
}

/** A drain holds the original key and owner across every awaited POST. */
export interface PendingCheckInScope {
  key: string;
  owner: number | null;
  generation: number;
}

export function capturePendingCheckInScope(): PendingCheckInScope {
  return {
    key: pendingCheckInsKey(),
    owner: getActiveUser(),
    generation: getActiveUserGeneration(),
  };
}

const isPendingScopeCurrent = (scope: PendingCheckInScope): boolean =>
  scope.generation === getActiveUserGeneration();

/** This account's dropped-check-in quarantine key. */
function droppedCheckInsKey(): string {
  return scopedKey(DROPPED_CHECKINS_KEY_BASE);
}

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
  /** Signed unit delta; absent entries retain the legacy full-target behavior. */
  completed_units?: number;
  /** Durable identity for exactly-once replay of an explicit signed delta. */
  operation_id?: string;
  /** Device-only identity for legacy replay; never sent as a backend operation ID. */
  replay_id?: string;
  timestamp: string;
  /** Explicit backfill day for a backdated log; replay forwards it verbatim. */
  completed_on?: string;
}

/** A queued check-in the replay gave up on, plus why and when it was dropped. */
export interface DroppedCheckIn {
  goal_id: number;
  did_complete: boolean;
  /** Signed unit delta carried over from the pending entry, when present. */
  completed_units?: number;
  /** Exactly-once operation identity carried over from the pending entry. */
  operation_id?: string;
  /** Device-only identity for legacy replay; never sent as a backend operation ID. */
  replay_id?: string;
  timestamp: string;
  /** Explicit backfill day carried over from the queued entry, if it had one. */
  completed_on?: string;
  /** Status of the response that made the entry permanently unpostable. */
  status: number;
  /** ISO instant the replay dropped the entry. */
  dropped_at: string;
  /**
   * Why it was dropped: ``'rejected'`` when the server refused it outright,
   * ``'gave_up'`` when an unclassified rejection kept recurring past the
   * replay's attempt cap and age floor (#2473). Records written before the
   * field existed carry none, and read as ``'rejected'``.
   */
  reason?: DroppedCheckInReason;
}

/** The two ways a replay drops a check-in; see ``DroppedCheckIn.reason``. */
export type DroppedCheckInReason = 'rejected' | 'gave_up';

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
  await AsyncStorage.setItem(habitsKey(), JSON.stringify(habits));
}

export async function loadHabits(): Promise<Habit[] | null> {
  const parsed = await getJsonArray<Habit>(habitsKey());
  if (parsed === null) return null;
  return parsed.map(rehydrateHabit);
}

export async function clearHabits(): Promise<void> {
  await AsyncStorage.removeItem(habitsKey());
}

/**
 * BUG-FE-STORAGE-002: append a check-in to the pending queue under a
 * serialized write lane. AsyncStorage offers no transactional RMW, so
 * two concurrent appenders that both read the queue before
 * either calls `setItem` would each write a single-item array,
 * silently losing one of the user's check-ins. Funnelling every write
 * to `pendingCheckInsKey()` through `serialize(...)` makes the
 * load-modify-write block atomic with respect to other appenders.
 */
export async function savePendingCheckIn(checkIn: PendingCheckIn): Promise<void> {
  // Resolve the scoped key ONCE: the lane and the write it guards must name
  // the same key even if the signed-in account changes while the write waits
  // its turn, and a queued lambda that re-resolved would write to the new
  // owner's queue under the old owner's lane.
  const key = pendingCheckInsKey();
  await serialize(key, async () => {
    let result: PendingCheckIn[] | null;
    try {
      result = await getJsonArrayForUpdate<PendingCheckIn>(key);
    } catch {
      // A transient read must abort the write; falling back to [] here would
      // overwrite an intact on-disk queue with a single-item array.
      reportDiagnostic('storage_read_failed', { storage: 'pending_checkins' });
      return;
    }
    const existing = result ?? [];
    existing.push(checkIn);
    await AsyncStorage.setItem(key, JSON.stringify(existing));
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
  const key = pendingCheckInsKey();
  await serialize(key, async () => {
    await AsyncStorage.setItem(key, JSON.stringify(checkIns));
  });
}

export async function loadPendingCheckIns(
  scope: PendingCheckInScope = capturePendingCheckInScope(),
  prepareForReplay = false,
): Promise<PendingCheckIn[]> {
  if (!prepareForReplay) return (await getJsonArray<PendingCheckIn>(scope.key)) ?? [];
  return serialize(scope.key, () => preparePendingReplay(scope));
}

/** Persist identities under the append lane before any legacy entry reaches a POST. */
async function preparePendingReplay(scope: PendingCheckInScope): Promise<PendingCheckIn[]> {
  if (!isPendingScopeCurrent(scope)) return [];
  try {
    const entries = (await getJsonArrayForUpdate<PendingCheckIn>(scope.key)) ?? [];
    if (!isPendingScopeCurrent(scope)) return [];
    let changed = false;
    const prepared = entries.map((entry) => {
      if (entry.operation_id || entry.replay_id) return entry;
      changed = true;
      return { ...entry, replay_id: uuidv4() };
    });
    if (changed) await AsyncStorage.setItem(scope.key, JSON.stringify(prepared));
    return isPendingScopeCurrent(scope) ? prepared : [];
  } catch {
    // A failed read or identity write must retain the queue and defer the POST.
    console.warn('[storage] could not prepare pending check-in identities; retaining queue');
    return [];
  }
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
  const key = pendingCheckInsKey();
  await serialize(key, () => AsyncStorage.removeItem(key));
}

/**
 * Remove only terminal replay entries from the queue as it exists now. The
 * foreground may have appended during a POST; rebuilding from the replay's
 * snapshot would erase that tap. Legacy entries are matched one at a time so
 * even an identical later append survives.
 */
export async function removePendingCheckIns(
  completed: PendingCheckIn[],
  scope: PendingCheckInScope,
): Promise<void> {
  const { key } = scope;
  if (completed.length === 0 || !isPendingScopeCurrent(scope)) return;
  await serialize(key, async () => {
    if (!isPendingScopeCurrent(scope)) return;
    let current: PendingCheckIn[] | null;
    try {
      current = await getJsonArrayForUpdate<PendingCheckIn>(key);
    } catch {
      reportDiagnostic('storage_read_failed', { storage: 'pending_checkins' });
      return;
    }
    const remaining = [...(current ?? [])];
    for (const entry of completed) {
      const index = remaining.findIndex((candidate) =>
        entry.operation_id
          ? candidate.operation_id === entry.operation_id
          : entry.replay_id
            ? candidate.replay_id === entry.replay_id
            : candidate.operation_id === undefined &&
              candidate.replay_id === undefined &&
              candidate.goal_id === entry.goal_id &&
              candidate.timestamp === entry.timestamp &&
              candidate.did_complete === entry.did_complete &&
              candidate.completed_units === entry.completed_units &&
              candidate.completed_on === entry.completed_on,
      );
      if (index >= 0) remaining.splice(index, 1);
    }
    if (!isPendingScopeCurrent(scope)) return;
    if (remaining.length === 0) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, JSON.stringify(remaining));
  });
}

/**
 * Append `entry` to the quarantine, keeping only the newest
 * `MAX_DROPPED_CHECK_INS` records. Runs inside the serialized lane, so the
 * read-modify-write is atomic with respect to the other quarantine writers.
 */
async function appendDroppedCheckIn(
  key: string,
  entry: DroppedCheckIn,
  generation: number,
): Promise<void> {
  let result: DroppedCheckIn[] | null;
  try {
    result = await getJsonArrayForUpdate<DroppedCheckIn>(key);
  } catch {
    // Same rule as the pending queue: a transient read aborts the write.
    // Falling back to [] would replace an intact quarantine with one record,
    // erasing the very losses the quarantine exists to report.
    reportDiagnostic('storage_read_failed', { storage: 'quarantine' });
    return;
  }
  const existing = result ?? [];
  if (
    existing.some((item) =>
      entry.operation_id
        ? item.operation_id === entry.operation_id
        : entry.replay_id !== undefined && item.replay_id === entry.replay_id,
    )
  )
    return;
  existing.push(entry);
  // Oldest-first storage, so trimming from the front evicts the oldest.
  if (getActiveUserGeneration() !== generation) return;
  await AsyncStorage.setItem(key, JSON.stringify(existing.slice(-MAX_DROPPED_CHECK_INS)));
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
export async function recordDroppedCheckIn(
  entry: DroppedCheckIn,
  owner: number | null = getActiveUser(),
): Promise<void> {
  if (getActiveUser() !== owner) return;
  const key = droppedCheckInsKey();
  const generation = getActiveUserGeneration();
  try {
    await serialize(key, async () => {
      if (getActiveUserGeneration() === generation)
        await appendDroppedCheckIn(key, entry, generation);
    });
  } catch {
    reportDiagnostic('storage_write_failed', { storage: 'quarantine' });
  }
}

/** Read the quarantine; an absent or unreadable key reads as "nothing lost". */
export async function loadDroppedCheckIns(): Promise<DroppedCheckIn[]> {
  return (await getJsonArray<DroppedCheckIn>(droppedCheckInsKey())) ?? [];
}

/**
 * Drop the quarantine — the user dismissed the notice, or logout is wiping the
 * device. Routed through the same serialized lane as `recordDroppedCheckIn` so
 * a clear cannot interleave with an inflight append and resurrect the record
 * it was supposed to remove (see `clearPendingCheckIns`).
 */
export async function clearDroppedCheckIns(): Promise<void> {
  const key = droppedCheckInsKey();
  await serialize(key, () => AsyncStorage.removeItem(key));
}
