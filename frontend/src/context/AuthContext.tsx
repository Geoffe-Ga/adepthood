import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { auth as authApi, setOnUnauthorized, setTokenGetter } from '@/api';
import { clearToken, loadToken, saveToken } from '@/storage/authStorage';

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Keep a ref-like mutable value for the token getter
  const tokenRef = React.useRef<string | null>(null);
  tokenRef.current = token;

  useEffect(() => {
    setTokenGetter(() => tokenRef.current);
    setOnUnauthorized(() => {
      clearToken();
      setToken(null);
    });
    return () => {
      setOnUnauthorized(null);
    };
  }, []);

  useEffect(() => {
    loadToken()
      .then((stored) => {
        if (stored) setToken(stored);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await authApi.login({ username: email, password });
    await saveToken(response.token);
    setToken(response.token);
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const response = await authApi.signup({ username: email, password });
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
