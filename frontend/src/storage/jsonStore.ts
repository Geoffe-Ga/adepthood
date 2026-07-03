import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Clears a poisoned AsyncStorage key on bad JSON so the next launch self-heals
 * (BUG-FRONTEND-INFRA-011). Shared by the storage modules that read JSON —
 * each previously carried a byte-identical copy of this helper.
 */
export async function resetCorruptKey(key: string, err: unknown): Promise<void> {
  console.warn(`[storage] corrupt JSON in ${key}, clearing to self-heal`, err);
  try {
    await AsyncStorage.removeItem(key);
  } catch (removeErr) {
    console.warn(`[storage] failed to clear corrupt key ${key}`, removeErr);
  }
}

/**
 * Read a JSON array from AsyncStorage with fail-safe semantics, returning
 * `null` when the value is absent or unreadable.
 *
 * The two failure modes are handled differently on purpose:
 *
 *   - A **transient** `getItem` rejection (Android SQLite hiccup, disk
 *     pressure) leaves the stored data untouched — it returns `null`
 *     WITHOUT calling `removeItem`, so a later read can still recover it.
 *   - Genuinely **corrupt** JSON (parse failure or a non-array payload)
 *     self-heals via `resetCorruptKey`, clearing the poisoned key so the
 *     next launch starts clean.
 *
 * Conflating the two — wrapping both `getItem` and `JSON.parse` in one
 * `try` whose `catch` clears the key — silently deletes good data on a
 * momentary read blip, which is the bug this helper exists to prevent.
 */
export async function getJsonArray<T>(key: string): Promise<T[] | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (err: unknown) {
    console.warn(`[storage] transient read error for ${key}, keeping stored data`, err);
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      await resetCorruptKey(key, new Error('expected array'));
      return null;
    }
    return parsed as T[];
  } catch (err: unknown) {
    await resetCorruptKey(key, err);
    return null;
  }
}
