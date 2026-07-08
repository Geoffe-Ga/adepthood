// Persists a "this reflection invitation was set aside" flag, keyed per
// reflection scope so a decline is honoured across launches for that scope only
// — a later scope (a new week/stage) still surfaces its own fresh invitation.
// Mirrors ``returnOfferStorage.ts``, but scoped rather than global.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = '@adepthood/reflection_dismissed:';
const FLAG_TRUE = 'true';

/** The AsyncStorage key that isolates one reflection scope's dismissal flag. */
function storageKey(scopeKey: string): string {
  return `${KEY_PREFIX}${scopeKey}`;
}

/** Record (or clear) the dismissal for a single reflection scope. */
export async function saveReflectionDismissed(scopeKey: string, value: boolean): Promise<void> {
  await AsyncStorage.setItem(storageKey(scopeKey), String(value));
}

/**
 * Whether the invitation for ``scopeKey`` was previously set aside. A storage
 * read failure resolves ``false`` (surface the invitation rather than crash) so
 * a flaky disk never suppresses a genuinely-due reflection.
 */
export async function loadReflectionDismissed(scopeKey: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(scopeKey));
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[reflectionDismissalStorage] failed to load dismissal flag', err);
    return false;
  }
}
