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
