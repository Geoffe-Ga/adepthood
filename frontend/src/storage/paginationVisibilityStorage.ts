import AsyncStorage from '@react-native-async-storage/async-storage';

import { reportDiagnostic } from '@/observability/diagnostics';
// Persists whether the Habits screen's in-body pagination bar is hidden. A
// single global flag (toggled from the header drawer) so the choice survives
// relaunches. Mirrors ``reflectionDismissalStorage.ts``, but global rather than
// per-scope.

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
  } catch {
    reportDiagnostic('storage_write_failed', { storage: 'pagination_visibility' });
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
  } catch {
    reportDiagnostic('storage_read_failed', { storage: 'pagination_visibility' });
    return false;
  }
}
