import AsyncStorage from '@react-native-async-storage/async-storage';

const ARCHIVED_KEY = '@adepthood/energy_scaffolding_archived';

// Clears poisoned storage on bad JSON so the next launch self-heals.
async function resetCorruptKey(key: string, err: unknown): Promise<void> {
  console.warn(`[storage] corrupt JSON in ${key}, clearing to self-heal`, err);
  try {
    await AsyncStorage.removeItem(key);
  } catch (removeErr) {
    console.warn(`[storage] failed to clear corrupt key ${key}`, removeErr);
  }
}

// Device-scoped (not wiped on logout) so the dismissal survives the next login.
export async function saveEnergyScaffoldingArchived(archived: boolean): Promise<void> {
  await AsyncStorage.setItem(ARCHIVED_KEY, JSON.stringify(archived));
}

export async function loadEnergyScaffoldingArchived(): Promise<boolean> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(ARCHIVED_KEY);
  } catch {
    return false; // transient IO error — don't touch stored data
  }
  if (raw === null) return false;
  try {
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
