import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Storage layer for the user's BYOK (Bring Your Own Key) LLM API key.
 *
 * The key is stored **only** on the device -- never uploaded to our backend
 * database -- so a server-side breach cannot leak user-owned LLM keys
 * (issue #185).
 *
 * Native uses ``expo-secure-store`` (Keychain / Keystore).  Web has no
 * SecureStore implementation in expo-secure-store v55, so a call there
 * throws ``TypeError: ... is not a function`` and the BYOK settings
 * screen crashes for every Expo Web user (BUG-FE-STORAGE-001).  The
 * web branch falls back to ``AsyncStorage`` (which resolves to
 * ``localStorage``) -- the same XSS-window risk already documented for
 * the auth token, and the same long-term migration plan applies.
 *
 * BUG-FE-STORAGE-004: empty / whitespace keys are rejected at the
 * boundary so an accidental save (e.g. paste of trailing newline) does
 * NOT clear the previous key without warning, and so the BotMason
 * router never receives a 401-guaranteed empty Bearer header.
 */
// expo-secure-store only allows alphanumerics plus `.`, `-`, `_` in keys.
const LLM_API_KEY_STORAGE_KEY = 'adepthood_llm_api_key'; // pragma: allowlist secret

const isWeb = Platform.OS === 'web';

export class EmptyApiKeyError extends Error {
  constructor() {
    super('LLM API key cannot be empty');
    this.name = 'EmptyApiKeyError';
  }
}

export async function saveLlmApiKey(apiKey: string): Promise<void> {
  // BUG-FE-STORAGE-004: trim whitespace at the boundary so the stored
  // value is canonical and a paste of "  sk-...  " does not silently
  // produce a 401 on the next BotMason call.  Empty / whitespace-only
  // input is rejected explicitly -- callers (the Settings screen)
  // surface this as an inline form error.
  const trimmed = apiKey.trim();
  if (!trimmed) throw new EmptyApiKeyError();
  if (isWeb) {
    // BUG-FE-STORAGE-001: web has no SecureStore implementation; fall
    // back to AsyncStorage (localStorage) so the BYOK settings screen
    // does not crash on Expo Web.  Same XSS-window tradeoff as the
    // auth token; see ``authStorage.ts`` for the long-term migration.
    await AsyncStorage.setItem(LLM_API_KEY_STORAGE_KEY, trimmed);
    return;
  }
  await SecureStore.setItemAsync(LLM_API_KEY_STORAGE_KEY, trimmed);
}

export async function loadLlmApiKey(): Promise<string | null> {
  if (isWeb) return AsyncStorage.getItem(LLM_API_KEY_STORAGE_KEY);
  return SecureStore.getItemAsync(LLM_API_KEY_STORAGE_KEY);
}

export async function clearLlmApiKey(): Promise<void> {
  if (isWeb) {
    await AsyncStorage.removeItem(LLM_API_KEY_STORAGE_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(LLM_API_KEY_STORAGE_KEY);
}
