/**
 * Persists the "Use Adepthood's own model" choice from the API-key screen.
 *
 * "Local" here means the open-source model Adepthood runs on servers it
 * operates, as opposed to a provider reached with a key the person brought.
 * While the choice is on, no user-owned key rides the ``X-LLM-API-Key``
 * header (``ApiKeyContext`` reads this), so a saved key stays on the device
 * and is not sent; off, the key is used as before.
 *
 * Device-local (AsyncStorage), like the key it stands beside. The read answers
 * ``null`` when nobody has chosen yet, so the context can apply its default
 * rather than this module deciding one. A read error fails to ``null`` for the
 * same reason; a write resolves whether it landed, and never rejects, so the
 * switch can show only a position the device has kept.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const LOCAL_MODEL_PREFERRED_KEY = '@adepthood/local_model_preferred';
const FLAG_TRUE = 'true';
const FLAG_FALSE = 'false';

/** The stored choice, or ``null`` when none has been made on this device. */
export async function loadLocalModelPreferred(): Promise<boolean | null> {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_MODEL_PREFERRED_KEY);
    if (raw === FLAG_TRUE) return true;
    if (raw === FLAG_FALSE) return false;
    return null;
  } catch (err) {
    console.warn('[localModelStorage] failed to load the choice', err);
    return null;
  }
}

/** Keep the choice. Resolves whether it was saved; never rejects. */
export async function saveLocalModelPreferred(value: boolean): Promise<boolean> {
  try {
    await AsyncStorage.setItem(LOCAL_MODEL_PREFERRED_KEY, value ? FLAG_TRUE : FLAG_FALSE);
    return true;
  } catch (err) {
    console.warn('[localModelStorage] failed to save the choice', err);
    return false;
  }
}
