// Remembers the handful of practices a user has most recently begun, so the
// catalog can offer a "Recently used" shortcut. Snapshots the display fields
// (not just the id) so a recent entry renders even when it belongs to another
// stage than the one the catalog is currently paging.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getJsonArrayForUpdate, resetCorruptKey } from './jsonStore';
import { serialize } from './serializedWrite';

const RECENT_PRACTICES_KEY = '@adepthood/recent_practices';

/** How many recent practices the shortcut keeps (most-recent-first). */
export const MAX_RECENT_PRACTICES = 6;

/** A lightweight snapshot of a practice the user recently began. */
export interface RecentPractice {
  id: number;
  name: string;
  mode: string | null;
  durationMinutes: number;
}

function isRecentPractice(value: unknown): value is RecentPractice {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'number' &&
    typeof entry.name === 'string' &&
    (entry.mode === null || typeof entry.mode === 'string') &&
    typeof entry.durationMinutes === 'number'
  );
}

function sanitize(value: unknown): RecentPractice[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecentPractice).slice(0, MAX_RECENT_PRACTICES);
}

/** Read the recent-practice list; self-heals (returns []) on missing/corrupt data. */
export async function loadRecentPractices(): Promise<RecentPractice[]> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(RECENT_PRACTICES_KEY);
  } catch (err) {
    // A transient read leaves the stored list intact for a later retry;
    // clearing here would delete good data on a momentary blip.
    console.warn(
      `[storage] transient read error for ${RECENT_PRACTICES_KEY}, keeping stored data`,
      err,
    );
    return [];
  }
  if (raw === null) return [];
  try {
    return sanitize(JSON.parse(raw));
  } catch (err) {
    await resetCorruptKey(RECENT_PRACTICES_KEY, err);
    return [];
  }
}

/**
 * Move ``entry`` to the front of the recent list (deduped by id), then persist.
 * Runs through the serialized write lane so concurrent appenders can't both
 * read the same list and clobber each other's prepend.
 *
 * The read leg uses ``getJsonArrayForUpdate`` rather than the fail-safe
 * ``loadRecentPractices``: a transient read failure must PROPAGATE so the
 * write aborts, because falling back to an empty list here would overwrite an
 * intact on-disk list with a single-item array. Corrupt/non-array JSON still
 * self-heals to ``null`` and the write proceeds from an empty list.
 */
export async function recordRecentPractice(entry: RecentPractice): Promise<void> {
  await serialize(RECENT_PRACTICES_KEY, async () => {
    let stored: RecentPractice[] | null;
    try {
      stored = await getJsonArrayForUpdate<RecentPractice>(RECENT_PRACTICES_KEY);
    } catch (err: unknown) {
      // A transient read must abort the write; falling back to [] here would
      // overwrite an intact on-disk list with a single-item array.
      console.warn(
        '[storage] transient read during recent-practice record, aborting write to preserve list',
        err,
      );
      return;
    }
    const existing = sanitize(stored ?? []);
    const deduped = existing.filter((item) => item.id !== entry.id);
    const next = [entry, ...deduped].slice(0, MAX_RECENT_PRACTICES);
    await AsyncStorage.setItem(RECENT_PRACTICES_KEY, JSON.stringify(next));
  });
}
