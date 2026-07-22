// Persists the "the morning-pages tip was set aside" flag so a decline is
// honoured across launches — the tip stays quiet once the person sets it down.
import AsyncStorage from '@react-native-async-storage/async-storage';

const MORNING_PAGES_TIP_DISMISSED_KEY = '@adepthood/morning_pages_tip_dismissed';
const FLAG_TRUE = 'true';

export async function saveMorningPagesTipDismissed(value: boolean): Promise<void> {
  await AsyncStorage.setItem(MORNING_PAGES_TIP_DISMISSED_KEY, String(value));
}

export async function loadMorningPagesTipDismissed(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(MORNING_PAGES_TIP_DISMISSED_KEY);
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[morningPagesTipStorage] failed to load dismissal flag', err);
    return false;
  }
}
