import AsyncStorage from '@react-native-async-storage/async-storage';

import { reportDiagnostic } from '@/observability/diagnostics';
// Persists the one-time "has seen the program welcome" flag (issue #836) so the
// editorial first-run intro shows exactly once across launches.

const HAS_SEEN_WELCOME_KEY = '@adepthood/has_seen_welcome';
const FLAG_TRUE = 'true';

export async function saveHasSeenWelcome(): Promise<void> {
  await AsyncStorage.setItem(HAS_SEEN_WELCOME_KEY, FLAG_TRUE);
}

export async function loadHasSeenWelcome(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(HAS_SEEN_WELCOME_KEY);
    return raw === FLAG_TRUE;
  } catch {
    reportDiagnostic('storage_read_failed', { storage: 'welcome' });
    return false;
  }
}

export async function clearHasSeenWelcome(): Promise<void> {
  await AsyncStorage.removeItem(HAS_SEEN_WELCOME_KEY);
}
