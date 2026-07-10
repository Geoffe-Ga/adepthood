// Persists whether the Habits screen's in-body pagination bar is hidden. A
// single global flag (toggled from the header drawer) so the choice survives
// relaunches. Mirrors ``reflectionDismissalStorage.ts``, but global rather than
// per-scope.
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@adepthood/habits_pagination_hidden';
const FLAG_TRUE = 'true';

/**
 * Record whether the pagination bar is hidden. A write failure is warned and
 * swallowed (never rejects) so a flaky disk cannot surface as an unhandled
 * rejection at the fire-and-forget call site; the in-memory toggle stands.
 */
export async function savePaginationBarHidden(hidden: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, String(hidden));
  } catch (err) {
    console.warn('[paginationVisibilityStorage] failed to save hidden flag', err);
  }
}

/**
 * Whether the pagination bar was previously hidden. A storage read failure
 * resolves ``false`` (show the bar rather than crash) so a flaky disk never
 * permanently strands the pagination controls out of view.
 */
export async function loadPaginationBarHidden(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[paginationVisibilityStorage] failed to load hidden flag', err);
    return false;
  }
}
