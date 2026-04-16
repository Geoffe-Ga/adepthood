import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { auth as authApi, setOnTokenRefreshed, setOnUnauthorized, setTokenGetter } from '@/api';
import { clearToken, loadToken, saveToken } from '@/storage/authStorage';
import {
  decodeJwtPayload,
  isTokenExpired,
  REFRESH_BUFFER_SECONDS,
  shouldRefreshToken,
} from '@/utils/token';

type LoginOrSignup = (_emailOrUsername: string, _pw: string) => Promise<void>;

interface AuthContextValue {
  token: string | null;
  isLoading: boolean;
  login: LoginOrSignup;
  signup: LoginOrSignup;
  logout: () => Promise<void>;
  onUnauthorized: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function silentRefresh(currentToken: string, onSuccess: (t: string) => void): void {
  authApi.refresh(currentToken).then(
    (res) => onSuccess(res.token),
    () => {
      /* silent fail — 401 retry is the fallback */
    },
  );
}

/** Schedule proactive token refresh before expiration. */
function useProactiveRefresh(
  token: string | null,
  tokenRef: React.MutableRefObject<string | null>,
  applyNewToken: (t: string) => void,
): void {
  useEffect(() => {
    if (!token || isTokenExpired(token)) return undefined;

    if (shouldRefreshToken(token)) {
      silentRefresh(token, applyNewToken);
      return undefined;
    }

    const payload = decodeJwtPayload(token);
    if (!payload) return undefined;

    const delay = payload.exp * 1000 - Date.now() - REFRESH_BUFFER_SECONDS * 1000;
    if (delay <= 0) return undefined;

    const timer = setTimeout(() => {
      const current = tokenRef.current;
      if (current) silentRefresh(current, applyNewToken);
    }, delay);

    return () => clearTimeout(timer);
  }, [token, tokenRef, applyNewToken]);
}

/**
 * BUG-AUTH-005: the storage write must complete before we drop the token
 * from state; otherwise a crash between the two leaves a stale token in
 * secure storage that hydrates on next launch.
 */
async function clearTokenThenReset(
  setToken: React.Dispatch<React.SetStateAction<string | null>>,
): Promise<void> {
  try {
    await clearToken();
  } catch (err: unknown) {
    console.warn('clearToken failed in onUnauthorized', err);
  }
  setToken(null);
}

/**
 * BUG-AUTH-001: a fire-and-forget saveToken loses the refreshed token if
 * the app is killed between the refresh response and the secure-storage
 * write. Await the persistence before surfacing the token to React state.
 *
 * BUG-FRONTEND-INFRA-012: if the user logged out while a refresh was in
 * flight, ``tokenRef.current`` is ``null`` and we must NOT resurrect the
 * session. Apply the new token only when the ref still holds the old value.
 */
async function saveTokenThenApply(
  newToken: string,
  setToken: React.Dispatch<React.SetStateAction<string | null>>,
  tokenRef: React.MutableRefObject<string | null>,
): Promise<void> {
  if (tokenRef.current === null) {
    // Logout won the race — drop the late refresh response on the floor.
    return;
  }
  try {
    await saveToken(newToken);
  } catch (err: unknown) {
    console.warn('saveToken failed in onTokenRefreshed', err);
    return;
  }
  if (tokenRef.current === null) return;
  setToken(newToken);
}

/** Register API-layer callbacks that bridge token state to the HTTP client. */
function useApiCallbacks(
  tokenRef: React.MutableRefObject<string | null>,
  setToken: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  // BUG-FRONTEND-INFRA-013: hold the getter in a ref that outlives the effect
  // so a mid-request logout (which clears ``tokenRef.current``) can't lose
  // the reference before the HTTP client reads it. On unmount we explicitly
  // clear the getter so the stale closure is not left pinned in the module.
  const stableGetter = useCallback(() => tokenRef.current, [tokenRef]);

  useEffect(() => {
    setTokenGetter(stableGetter);
    setOnUnauthorized(() => {
      void clearTokenThenReset(setToken);
    });
    setOnTokenRefreshed((t: string) => {
      void saveTokenThenApply(t, setToken, tokenRef);
    });
    return () => {
      setTokenGetter(null);
      setOnUnauthorized(null);
      setOnTokenRefreshed(null);
    };
  }, [stableGetter, setToken, tokenRef]);
}

/** Load token from storage on mount, discarding expired tokens. */
function useLoadStoredToken(
  setToken: React.Dispatch<React.SetStateAction<string | null>>,
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  useEffect(() => {
    loadToken()
      .then((stored) => {
        if (stored && !isTokenExpired(stored)) {
          setToken(stored);
        } else if (stored) {
          clearToken();
        }
      })
      .finally(() => setIsLoading(false));
  }, [setToken, setIsLoading]);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const tokenRef = React.useRef<string | null>(null);
  tokenRef.current = token;

  const applyNewToken = useCallback(async (newToken: string) => {
    await saveToken(newToken);
    setToken(newToken);
  }, []);

  useApiCallbacks(tokenRef, setToken);
  useProactiveRefresh(token, tokenRef, applyNewToken);
  useLoadStoredToken(setToken, setIsLoading);

  const login = useCallback(async (email: string, password: string) => {
    const response = await authApi.login({ email, password });
    await saveToken(response.token);
    setToken(response.token);
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const response = await authApi.signup({ email, password });
    await saveToken(response.token);
    setToken(response.token);
  }, []);

  const logout = useCallback(async () => {
    await clearToken();
    setToken(null);
  }, []);

  // BUG-AUTH-005: mirror the persistence-first ordering used by the API-layer
  // onUnauthorized hook so callers of the context-exposed helper get the same
  // crash-safety guarantee.
  const onUnauthorized = useCallback(() => {
    void clearTokenThenReset(setToken);
  }, []);

  const value = useMemo(
    () => ({ token, isLoading, login, signup, logout, onUnauthorized }),
    [token, isLoading, login, signup, logout, onUnauthorized],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
