import AsyncStorage from '@react-native-async-storage/async-storage';

const ARCHIVED_KEY = '@adepthood/energy_scaffolding_archived';

/**
 * BUG-FRONTEND-INFRA-011 — when AsyncStorage hands back malformed JSON we
 * clear the poisoned key so the next launch self-heals rather than parsing
 * the same garbage forever.
 */
async function resetCorruptKey(key: string, err: unknown): Promise<void> {
  console.warn(`[storage] corrupt JSON in ${key}, clearing to self-heal`, err);
  try {
    await AsyncStorage.removeItem(key);
  } catch (removeErr) {
    console.warn(`[storage] failed to clear corrupt key ${key}`, removeErr);
  }
}

/**
 * Persist whether the user has archived the Energy Scaffolding CTA. Stored
 * at device scope (not wiped on logout) so the dismissal survives the next
 * login — re-showing an archived CTA on every login is the bug this fixes.
 */
export async function saveEnergyScaffoldingArchived(archived: boolean): Promise<void> {
  await AsyncStorage.setItem(ARCHIVED_KEY, JSON.stringify(archived));
}

export async function loadEnergyScaffoldingArchived(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(ARCHIVED_KEY);
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'boolean') {
      await resetCorruptKey(ARCHIVED_KEY, new Error('expected boolean'));
      return false;
    }
    return parsed;
  } catch (err: unknown) {
    await resetCorruptKey(ARCHIVED_KEY, err);
    return false;
  }
}
