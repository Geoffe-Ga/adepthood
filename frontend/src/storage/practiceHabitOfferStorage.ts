import AsyncStorage from '@react-native-async-storage/async-storage';

import { reportDiagnostic } from '@/observability/diagnostics';
import { getActiveUser } from '@/storage/userScope';

/** A new adoption can be offered once; another account never inherits the answer. */
function offerKey(adoptionId: number, owner: number | null): string | null {
  if (owner === null || !Number.isInteger(adoptionId) || adoptionId <= 0) return null;
  return `@adepthood/practice_habit_offer_answered/${adoptionId}#u${owner}`;
}

/** Unknown storage stays quiet rather than re-asking a person whose answer we cannot read. */
export async function loadPracticeHabitOfferAnswered(
  adoptionId: number,
  owner = getActiveUser(),
): Promise<boolean | null> {
  const key = offerKey(adoptionId, owner);
  if (!key) return null;
  try {
    const value = await AsyncStorage.getItem(key);
    if (value === null) return false;
    return value === 'true' ? true : null;
  } catch {
    reportDiagnostic('storage_read_failed');
    return null;
  }
}

/** Capture owner at the interaction, before any asynchronous creation or link operation. */
export async function savePracticeHabitOfferAnswered(
  adoptionId: number,
  owner = getActiveUser(),
): Promise<boolean> {
  const key = offerKey(adoptionId, owner);
  if (!key) return false;
  try {
    await AsyncStorage.setItem(key, 'true');
    return true;
  } catch {
    reportDiagnostic('storage_write_failed');
    return false;
  }
}
