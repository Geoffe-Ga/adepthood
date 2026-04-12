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
  /** Persist a new key to SecureStore and update context state. */
  saveApiKey: (_key: string) => Promise<void>;
  /** Remove the stored key (SecureStore + context state). */
  clearApiKey: () => Promise<void>;
}

const ApiKeyContext = createContext<ApiKeyContextValue | null>(null);

export function ApiKeyProvider({ children }: { children: React.ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
      .then((stored) => setApiKey(stored))
      .finally(() => setIsLoading(false));
  }, []);

  const saveApiKey = useCallback(async (key: string) => {
    await saveLlmApiKey(key);
    setApiKey(key);
  }, []);

  const clearApiKey = useCallback(async () => {
    await clearLlmApiKey();
    setApiKey(null);
  }, []);

  const value = useMemo(
    () => ({ apiKey, isLoading, saveApiKey, clearApiKey }),
    [apiKey, isLoading, saveApiKey, clearApiKey],
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
