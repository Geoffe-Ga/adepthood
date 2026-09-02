// Persists the "the voice-readiness band was set aside" flag so a decline is
// honoured across launches — the band stays quiet once the person sets it down.
//
// One flag rather than one per state. A person declining this is declining the
// whole subject, not one phrasing of it, and a per-state key would bring the
// band back the moment they granted consent — turning a decline into a snooze
// they never asked for.
import AsyncStorage from '@react-native-async-storage/async-storage';

const VOICE_READINESS_DISMISSED_KEY = '@adepthood/voice_readiness_dismissed';
const FLAG_TRUE = 'true';

export async function saveVoiceReadinessDismissed(value: boolean): Promise<void> {
  await AsyncStorage.setItem(VOICE_READINESS_DISMISSED_KEY, String(value));
}

export async function loadVoiceReadinessDismissed(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(VOICE_READINESS_DISMISSED_KEY);
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[voiceReadinessDismissalStorage] failed to load dismissal flag', err);
    return false;
  }
}
