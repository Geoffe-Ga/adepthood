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

/** Register API-layer callbacks that bridge token state to the HTTP client. */
function useApiCallbacks(
  tokenRef: React.MutableRefObject<string | null>,
  setToken: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  useEffect(() => {
    setTokenGetter(() => tokenRef.current);
    setOnUnauthorized(() => {
      clearToken();
      setToken(null);
    });
    setOnTokenRefreshed((t: string) => {
      saveToken(t);
      setToken(t);
    });
    return () => {
      setOnUnauthorized(null);
      setOnTokenRefreshed(null);
    };
  }, [tokenRef, setToken]);
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

  const onUnauthorized = useCallback(() => {
    clearToken();
    setToken(null);
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
