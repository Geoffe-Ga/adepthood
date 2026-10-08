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
import { LOCAL_MODEL_AVAILABLE } from '@/constants/localModel';
import { clearLlmApiKey, loadLlmApiKey, saveLlmApiKey } from '@/storage/llmKeyStorage';
import { loadLocalModelPreferred, saveLocalModelPreferred } from '@/storage/localModelStorage';

/**
 * React context managing the user-owned BYOK LLM API key (issue #185).
 *
 * The key is loaded from SecureStore on mount, exposed read-only via
 * {@link useApiKey}, and registered with the HTTP client so supported
 * model-powered requests automatically carry the ``X-LLM-API-Key`` header
 * when a key is present.
 *
 * Between calls the key lives in device storage. On supported requests it is
 * transmitted to Adepthood, then forwarded to the provider; Adepthood never
 * persists it in the server database or returns it in an API response.
 *
 * The future Adepthood-model choice stays release-gated until a real
 * Adepthood-operated backend provider exists. While unavailable, stored legacy
 * preferences are ignored and the registered getter keeps returning the BYOK
 * key; merely withholding it would fall back to the shared provider and would
 * not constitute a self-hosted model path.
 */

/**
 * What ``localModel`` is until the person chooses. Off: a device with no
 * stored choice keeps sending its key, as it did before the choice existed.
 * Flip this once the model is live and should be the default.
 */
export const LOCAL_MODEL_DEFAULT = false;

/** Outcome of a {@link ApiKeyContextValue.saveApiKey} call. */
export interface ApiKeySaveResult {
  /**
   * True when the write reached SecureStore; false when it fell back to
   * session-only because the SecureStore write failed.
   */
  persisted: boolean;
}

/** Outcome of a {@link ApiKeyContextValue.setLocalModel} call. */
export interface LocalModelSaveResult {
  /**
   * True when the choice reached device storage; false when it holds for this
   * session only because the write failed.
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
  /**
   * True while requests go to Adepthood's own model rather than a provider
   * reached with the stored key. While true the key is kept but not sent.
   */
  localModel: boolean;
  /**
   * Choose Adepthood's own model (true) or the stored key (false). Applied to
   * this session at once; resolves whether the choice also reached storage.
   */
  setLocalModel: (_value: boolean) => Promise<LocalModelSaveResult>;
}

const ApiKeyContext = createContext<ApiKeyContextValue | null>(null);

/**
 * Bridge the in-memory key to the API layer: register a getter the HTTP client
 * polls per request, plus a reset seam that session teardown invokes so a
 * logged-out user's key can never ride the ``X-LLM-API-Key`` header into the
 * next user's requests on a shared device. The reset nulls the ref
 * synchronously so the getter returns null immediately, before any re-render
 * triggered by ``setApiKey`` lands. Both seams are cleared on unmount.
 *
 * Once the provider release gate opens, the getter answers ``null`` while
 * Adepthood's own model is chosen, without touching what is stored.
 */
function useLlmApiKeyBridge(
  apiKeyRef: React.MutableRefObject<string | null>,
  localModelRef: React.MutableRefObject<boolean>,
  setApiKey: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  useEffect(() => {
    setLlmApiKeyGetter(() =>
      LOCAL_MODEL_AVAILABLE && localModelRef.current ? null : apiKeyRef.current,
    );
    setLlmApiKeyReset(() => {
      apiKeyRef.current = null;
      setApiKey(null);
    });
    return () => {
      setLlmApiKeyGetter(null);
      setLlmApiKeyReset(null);
    };
  }, [apiKeyRef, localModelRef, setApiKey]);
}

/**
 * Read the stored model choice once on mount; a device with none keeps
 * {@link LOCAL_MODEL_DEFAULT}. Never blocks the key's own load.
 */
function useLoadLocalModelPreference(
  setLocalModel: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (!LOCAL_MODEL_AVAILABLE) {
      setLocalModel(false);
      return;
    }
    void loadLocalModelPreferred().then((stored) => {
      if (stored !== null) setLocalModel(stored);
    });
  }, [setLocalModel]);
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

/** Refuse activation until the self-hosted provider exists; otherwise persist the choice. */
function useSetLocalModel(
  localModelRef: React.MutableRefObject<boolean>,
  setLocalModelState: React.Dispatch<React.SetStateAction<boolean>>,
): (_next: boolean) => Promise<LocalModelSaveResult> {
  return useCallback(
    async (next: boolean): Promise<LocalModelSaveResult> => {
      if (!LOCAL_MODEL_AVAILABLE) {
        localModelRef.current = false;
        setLocalModelState(false);
        return { persisted: false };
      }
      // Applied before the write resolves, and synchronously to the ref, so the
      // very next request already honours the choice.
      localModelRef.current = next;
      setLocalModelState(next);
      const persisted = await saveLocalModelPreferred(next);
      return { persisted };
    },
    [localModelRef, setLocalModelState],
  );
}

export function ApiKeyProvider({ children }: { children: React.ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [localModel, setLocalModelState] = useState(LOCAL_MODEL_DEFAULT);

  // Mirror the state into refs so the getter we register with the API layer
  // always reads the latest values without needing to re-register on every
  // change.
  const apiKeyRef = useRef<string | null>(null);
  apiKeyRef.current = apiKey;
  const localModelRef = useRef(LOCAL_MODEL_DEFAULT);
  localModelRef.current = localModel;

  useLlmApiKeyBridge(apiKeyRef, localModelRef, setApiKey);
  useLoadStoredApiKey(setApiKey, setLoadError, setIsLoading);
  useLoadLocalModelPreference(setLocalModelState);

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

  const setLocalModel = useSetLocalModel(localModelRef, setLocalModelState);

  const value = useMemo(
    () => ({ apiKey, isLoading, loadError, saveApiKey, clearApiKey, localModel, setLocalModel }),
    [apiKey, isLoading, loadError, saveApiKey, clearApiKey, localModel, setLocalModel],
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
