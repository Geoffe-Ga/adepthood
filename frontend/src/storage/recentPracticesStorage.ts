// Remembers the handful of practices a user has most recently begun, so the
// catalog can offer a "Recently used" shortcut. Snapshots the display fields
// (not just the id) so a recent entry renders even when it belongs to another
// stage than the one the catalog is currently paging.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getJsonArrayForUpdate, resetCorruptKey } from './jsonStore';
import { serialize } from './serializedWrite';
import { scopedKey } from './userScope';

/**
 * Which practices someone recently began is their activity, not the device's,
 * so the list is namespaced per account (BUG-FE-STATE-001): a device that
 * changes hands must not offer the incoming user the previous owner's
 * shortcuts. Namespacing rather than wiping on logout is deliberate — a
 * returning user still finds their own list where they left it.
 */
const RECENT_PRACTICES_KEY_BASE = '@adepthood/recent_practices';

/** This account's recent-practice list key — also its serialized write lane. */
function recentPracticesKey(): string {
  return scopedKey(RECENT_PRACTICES_KEY_BASE);
}

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
  const key = recentPracticesKey();
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (err) {
    // A transient read leaves the stored list intact for a later retry;
    // clearing here would delete good data on a momentary blip.
    console.warn(`[storage] transient read error for ${key}, keeping stored data`, err);
    return [];
  }
  if (raw === null) return [];
  try {
    return sanitize(JSON.parse(raw));
  } catch (err) {
    await resetCorruptKey(key, err);
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
  // Resolve once: the lane and the write it guards must name the same key even
  // if the signed-in account changes while the write waits its turn.
  const key = recentPracticesKey();
  await serialize(key, async () => {
    let stored: RecentPractice[] | null;
    try {
      stored = await getJsonArrayForUpdate<RecentPractice>(key);
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
    await AsyncStorage.setItem(key, JSON.stringify(next));
  });
}
