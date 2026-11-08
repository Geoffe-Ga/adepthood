import AsyncStorage from '@react-native-async-storage/async-storage';

import { reportDiagnostic } from '@/observability/diagnostics';

/**
 * A program start date the person picked that never reached the server (#3097).
 *
 * A first-run scaffolding pick made offline has no earlier date to fall back
 * on, so it is held here -- as the YYYY-MM-DD the person chose, in the account
 * zone -- and sent again by the next session's reconcile before the server's
 * own answer is adopted. Without it the server's default stamp would silently
 * replace the pick on the next launch.
 */
const PENDING_PROGRAM_START_KEY = '@adepthood/pending_program_start_day';

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function savePendingProgramStart(day: string): Promise<void> {
  await AsyncStorage.setItem(PENDING_PROGRAM_START_KEY, day);
}

/** The held pick, or null when there is none (or it cannot be read). */
export async function loadPendingProgramStart(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_PROGRAM_START_KEY);
    return raw !== null && DAY_KEY_RE.test(raw) ? raw : null;
  } catch {
    reportDiagnostic('storage_read_failed', { storage: 'program' });
    return null;
  }
}

export async function clearPendingProgramStart(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_PROGRAM_START_KEY);
}
