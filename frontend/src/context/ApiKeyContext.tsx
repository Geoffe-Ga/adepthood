import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { setLlmApiKeyGetter } from '@/api';
import { clearLlmApiKey, loadLlmApiKey, saveLlmApiKey } from '@/storage/llmKeyStorage';

/**
 * React context managing the user-owned BYOK LLM API key (issue #185).
 *
 * The key is loaded from SecureStore on mount, exposed read-only via
 * {@link useApiKey}, and registered with the HTTP client so that BotMason
 * chat requests automatically carry the ``X-LLM-API-Key`` header when a key
 * is present.
 *
 * The key is **never** uploaded to the server database and **never** returned
 * in any API response — it lives only on the device.
 */

interface ApiKeyContextValue {
  /** Current user-owned key, or null if none is stored. */
  apiKey: string | null;
  /** True until the initial load from SecureStore completes. */
  isLoading: boolean;
  /**
   * BUG-FRONTEND-INFRA-017: populated when the initial SecureStore read,
   * save, or clear throws. Callers can surface this to the user (e.g.,
   * "Secure storage is unavailable — your key won't persist across
   * launches") instead of silently running with a blank key.
   */
  loadError: Error | null;
  /** Persist a new key to SecureStore and update context state. */
  saveApiKey: (_key: string) => Promise<void>;
  /** Remove the stored key (SecureStore + context state). */
  clearApiKey: () => Promise<void>;
}

const ApiKeyContext = createContext<ApiKeyContextValue | null>(null);

export function ApiKeyProvider({ children }: { children: React.ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);

  // Mirror the state into a ref so the getter we register with the API layer
  // always reads the latest value without needing to re-register on every
  // change.
  const apiKeyRef = useRef<string | null>(null);
  apiKeyRef.current = apiKey;

  useEffect(() => {
    setLlmApiKeyGetter(() => apiKeyRef.current);
    return () => setLlmApiKeyGetter(null);
  }, []);

  useEffect(() => {
    loadLlmApiKey()
      .then((stored) => {
        setApiKey(stored);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        console.warn('[ApiKeyContext] SecureStore load failed', err);
        // Fall back to in-memory operation (key still usable for this session
        // via saveApiKey; won't persist across launches until the store
        // recovers).
        setApiKey(null);
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => setIsLoading(false));
  }, []);

  const saveApiKey = useCallback(async (key: string) => {
    try {
      await saveLlmApiKey(key);
      setLoadError(null);
    } catch (err: unknown) {
      console.warn('[ApiKeyContext] SecureStore save failed', err);
      setLoadError(err instanceof Error ? err : new Error(String(err)));
      // Set state anyway so the key is at least usable this session.
    }
    setApiKey(key);
  }, []);

  const clearApiKey = useCallback(async () => {
    try {
      await clearLlmApiKey();
      setLoadError(null);
    } catch (err: unknown) {
      console.warn('[ApiKeyContext] SecureStore clear failed', err);
      setLoadError(err instanceof Error ? err : new Error(String(err)));
    }
    setApiKey(null);
  }, []);

  const value = useMemo(
    () => ({ apiKey, isLoading, loadError, saveApiKey, clearApiKey }),
    [apiKey, isLoading, loadError, saveApiKey, clearApiKey],
  );

  return <ApiKeyContext.Provider value={value}>{children}</ApiKeyContext.Provider>;
}

export function useApiKey(): ApiKeyContextValue {
  const ctx = useContext(ApiKeyContext);
  if (!ctx) {
    throw new Error('useApiKey must be used within an ApiKeyProvider');
  }
  return ctx;
}
