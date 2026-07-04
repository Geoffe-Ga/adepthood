/**
 * Storage layer for the user's BYOK (Bring Your Own Key) LLM API key — a thin
 * wrapper over the shared secure-string store.
 *
 * The key is stored **only** on the device -- never uploaded to our backend
 * database -- so a server-side breach cannot leak user-owned LLM keys.
 *
 * The native-Keychain / web-localStorage fallback, the trim/reject-empty guard,
 * and the web XSS-window tradeoff all live in ``secureStringStore.ts``; read
 * that file's header for the security rationale before touching the web path.
 */

import { createSecureStringStore } from './secureStringStore';

// expo-secure-store only allows alphanumerics plus `.`, `-`, `_` in keys.
const LLM_API_KEY_STORAGE_KEY = 'adepthood_llm_api_key'; // pragma: allowlist secret

export class EmptyApiKeyError extends Error {
  constructor() {
    super('LLM API key cannot be empty');
    this.name = 'EmptyApiKeyError';
  }
}

// BUG-FE-STORAGE-001: the BYOK key's web-fallback accepted-risk site. Web has
// no SecureStore implementation, so persistence falls back to localStorage
// inside secureStringStore.ts; this marker keeps that site grep-able here.
const apiKeyStore = createSecureStringStore(LLM_API_KEY_STORAGE_KEY, EmptyApiKeyError);

export async function saveLlmApiKey(apiKey: string): Promise<void> {
  await apiKeyStore.save(apiKey);
}

export async function loadLlmApiKey(): Promise<string | null> {
  return apiKeyStore.load();
}

export async function clearLlmApiKey(): Promise<void> {
  await apiKeyStore.clear();
}
