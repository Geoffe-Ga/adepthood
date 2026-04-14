import * as SecureStore from 'expo-secure-store';

/**
 * Storage layer for the user's BYOK (Bring Your Own Key) LLM API key.
 *
 * The key is stored **only** on the device via `expo-secure-store` — it is
 * never uploaded to our backend database. This eliminates server-side breach
 * liability for user-owned keys and is the storage contract guaranteed by
 * issue #185.
 */
// expo-secure-store only allows alphanumerics plus `.`, `-`, `_` in keys.
const LLM_API_KEY_STORAGE_KEY = 'adepthood_llm_api_key'; // pragma: allowlist secret

export async function saveLlmApiKey(apiKey: string): Promise<void> {
  await SecureStore.setItemAsync(LLM_API_KEY_STORAGE_KEY, apiKey);
}

export async function loadLlmApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(LLM_API_KEY_STORAGE_KEY);
}

export async function clearLlmApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(LLM_API_KEY_STORAGE_KEY);
}
