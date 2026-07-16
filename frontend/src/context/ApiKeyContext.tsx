import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { setLlmApiKeyGetter, setLlmApiKeyReset } from '@/api';
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

/** Outcome of a {@link ApiKeyContextValue.saveApiKey} call. */
export interface ApiKeySaveResult {
  /**
   * True when the write reached SecureStore; false when it fell back to
   * session-only because the SecureStore write failed.
   */
  persisted: boolean;
}

/** Outcome of a {@link ApiKeyContextValue.clearApiKey} call. */
export interface ApiKeyClearResult {
  /**
   * True when the delete reached SecureStore; false when the key was only
   * dropped from session state because the SecureStore delete failed.
   */
  cleared: boolean;
}

interface ApiKeyContextValue {
  /** Current user-owned key, or null if none is stored. */
  apiKey: string | null;
  /** True until the initial load from SecureStore completes. */
  isLoading: boolean;
  /**
   * Set to the thrown error when the initial SecureStore read, save, or
   * clear fails; null while storage is healthy. ApiKeySettingsScreen surfaces
   * this as a "secure storage unavailable" warning so a keychain failure is
   * visible instead of the app silently running with a blank, non-persisted key.
   */
  loadError: Error | null;
  /**
   * Persist a new key and update context state. Resolves with
   * ``persisted: true`` when the write reached SecureStore, or
   * ``persisted: false`` when it fell back to session-only (the write failed).
   */
  saveApiKey: (_key: string) => Promise<ApiKeySaveResult>;
  /**
   * Remove the stored key (SecureStore + context state). Resolves with
   * ``cleared: true`` when the delete reached SecureStore, or ``cleared: false``
   * when the key was only dropped from session state (the delete failed).
   */
  clearApiKey: () => Promise<ApiKeyClearResult>;
}

const ApiKeyContext = createContext<ApiKeyContextValue | null>(null);

/**
 * Bridge the in-memory key to the API layer: register a getter the HTTP client
 * polls per request, plus a reset seam that session teardown invokes so a
 * logged-out user's key can never ride the ``X-LLM-API-Key`` header into the
 * next user's requests on a shared device. The reset nulls the ref
 * synchronously so the getter returns null immediately, before any re-render
 * triggered by ``setApiKey`` lands. Both seams are cleared on unmount.
 */
function useLlmApiKeyBridge(
  apiKeyRef: React.MutableRefObject<string | null>,
  setApiKey: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  useEffect(() => {
    setLlmApiKeyGetter(() => apiKeyRef.current);
    setLlmApiKeyReset(() => {
      apiKeyRef.current = null;
      setApiKey(null);
    });
    return () => {
      setLlmApiKeyGetter(null);
      setLlmApiKeyReset(null);
    };
  }, [apiKeyRef, setApiKey]);
}

/**
 * Load the stored key from SecureStore on mount. On failure, fall back to
 * in-memory operation (the key stays usable this session via saveApiKey; it
 * won't persist across launches until the store recovers) and surface the
 * error so the screen can warn the user.
 */
function useLoadStoredApiKey(
  setApiKey: React.Dispatch<React.SetStateAction<string | null>>,
  setLoadError: React.Dispatch<React.SetStateAction<Error | null>>,
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  useEffect(() => {
    loadLlmApiKey()
      .then((stored) => {
        setApiKey(stored);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        console.warn('[ApiKeyContext] SecureStore load failed', err);
        setApiKey(null);
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => setIsLoading(false));
  }, [setApiKey, setLoadError, setIsLoading]);
}

export function ApiKeyProvider({ children }: { children: React.ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);

  // Mirror the state into a ref so the getter we register with the API layer
  // always reads the latest value without needing to re-register on every
  // change.
  const apiKeyRef = useRef<string | null>(null);
  apiKeyRef.current = apiKey;

  useLlmApiKeyBridge(apiKeyRef, setApiKey);
  useLoadStoredApiKey(setApiKey, setLoadError, setIsLoading);

  const saveApiKey = useCallback(async (key: string): Promise<ApiKeySaveResult> => {
    let persisted = false;
    try {
      await saveLlmApiKey(key);
      setLoadError(null);
      persisted = true;
    } catch (err: unknown) {
      console.warn('[ApiKeyContext] SecureStore save failed', err);
      setLoadError(err instanceof Error ? err : new Error(String(err)));
      // Set state anyway so the key is at least usable this session.
    }
    setApiKey(key);
    return { persisted };
  }, []);

  const clearApiKey = useCallback(async (): Promise<ApiKeyClearResult> => {
    let cleared = false;
    try {
      await clearLlmApiKey();
      setLoadError(null);
      cleared = true;
    } catch (err: unknown) {
      console.warn('[ApiKeyContext] SecureStore clear failed', err);
      setLoadError(err instanceof Error ? err : new Error(String(err)));
      // Drop the key from session state anyway so the user isn't stuck with it.
    }
    setApiKey(null);
    return { cleared };
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
