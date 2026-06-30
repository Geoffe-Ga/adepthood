// Persists the one-time "has seen the program welcome" flag (issue #836) so the
// editorial first-run intro shows exactly once across launches.
import AsyncStorage from '@react-native-async-storage/async-storage';

const HAS_SEEN_WELCOME_KEY = '@adepthood/has_seen_welcome';
const FLAG_TRUE = 'true';

export async function saveHasSeenWelcome(): Promise<void> {
  await AsyncStorage.setItem(HAS_SEEN_WELCOME_KEY, FLAG_TRUE);
}

export async function loadHasSeenWelcome(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(HAS_SEEN_WELCOME_KEY);
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[welcomeStorage] failed to load welcome flag', err);
    return false;
  }
}

export async function clearHasSeenWelcome(): Promise<void> {
  await AsyncStorage.removeItem(HAS_SEEN_WELCOME_KEY);
}
