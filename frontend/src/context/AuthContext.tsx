import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { auth as authApi, setOnTokenRefreshed, setOnUnauthorized, setTokenGetter } from '@/api';
import { clearToken, loadToken, saveToken } from '@/storage/authStorage';
import { clearHabits, clearPendingCheckIns } from '@/storage/habitStorage';
import { clearLlmApiKey } from '@/storage/llmKeyStorage';
import { clearAllNotificationData } from '@/storage/notificationStorage';
import { resetAllStores } from '@/store/registry';
import { detectDeviceTimezone } from '@/utils/dateUtils';
import {
  decodeJwtPayload,
  isTokenExpired,
  REFRESH_BUFFER_SECONDS,
  shouldRefreshToken,
} from '@/utils/token';

type LoginOrSignup = (_emailOrUsername: string, _pw: string) => Promise<void>;

/**
 * BUG-NAV-001 / BUG-NAV-002: the navigator used to gate on the raw ``token``
 * field, so any transient 401 that nulled the token also unmounted the
 * authenticated tree and booted the user to Signup. The explicit state
 * machine below lets the navigator distinguish "logged out" from "prompt
 * the user to re-authenticate without tearing down their navigation state".
 *
 * Transitions:
 *
 *   loading ───▶ authenticated (valid stored token)
 *   loading ───▶ anonymous     (no / expired / corrupt stored token)
 *   anonymous ─▶ authenticated (login / signup success)
 *   authenticated ─▶ reauth-required (401 → onUnauthorized)
 *   authenticated ─▶ anonymous (explicit logout)
 *   reauth-required ─▶ authenticated (re-auth sheet succeeded → login/signup)
 *   reauth-required ─▶ anonymous (user dismissed the sheet)
 *
 * ``loading`` is a one-shot cold-start state. Once bootstrap settles we
 * never rewind to ``loading`` — a mid-session storage read must not
 * collapse the navigator to a spinner (BUG-NAV-002).
 */
export type AuthStatus = 'loading' | 'authenticated' | 'reauth-required' | 'anonymous';

interface AuthContextValue {
  token: string | null;
  authStatus: AuthStatus;
  /** Mirrors ``authStatus === 'loading'``. Kept for backwards compatibility. */
  isLoading: boolean;
  login: LoginOrSignup;
  signup: LoginOrSignup;
  logout: () => Promise<void>;
  onUnauthorized: () => void;
  /** User dismissed the re-auth sheet: treat as an explicit logout. */
  dismissReauth: () => Promise<void>;
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

interface AuthMutators {
  setToken: React.Dispatch<React.SetStateAction<string | null>>;
  setAuthStatus: React.Dispatch<React.SetStateAction<AuthStatus>>;
}

/**
 * BUG-FE-STATE-001: every logout path (explicit ``logout`` and the re-auth
 * sheet's "sign out instead" button) must wipe the in-memory Zustand stores
 * AND the AsyncStorage persistence keys so the next user on the device
 * doesn't inherit the previous user's habits, stage progress, or BYOK key.
 * The storage clears are wrapped in try/catch so one failing key doesn't
 * leave the rest of the wipe half-done.
 */
async function wipeUserState(): Promise<void> {
  resetAllStores();
  const clears: Array<[string, Promise<void>]> = [
    ['habits', clearHabits()],
    ['pending check-ins', clearPendingCheckIns()],
    ['LLM API key', clearLlmApiKey()],
    ['notification data', clearAllNotificationData()],
  ];
  // Run the clears concurrently — they target independent AsyncStorage keys —
  // but surface every failure via ``allSettled`` so one dead key doesn't
  // silently strand the others.
  const results = await Promise.allSettled(clears.map(([, promise]) => promise));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const label = clears[index]?.[0] ?? 'unknown';
      console.warn(`[auth] failed to clear ${label} on logout`, result.reason);
    }
  });
}

/**
 * BUG-AUTH-005 / BUG-NAV-001: the storage write must complete before we drop
 * the token from state; otherwise a crash between the two leaves a stale
 * token in secure storage that hydrates on next launch. When the API layer
 * reports 401 we transition to ``'reauth-required'`` (so the navigator keeps
 * Tabs mounted), not ``'anonymous'``.
 */
async function clearTokenForReauth(mutators: AuthMutators): Promise<void> {
  try {
    await clearToken();
  } catch (err: unknown) {
    console.warn('clearToken failed in onUnauthorized', err);
  }
  mutators.setToken(null);
  mutators.setAuthStatus((prev) => (prev === 'loading' ? 'anonymous' : 'reauth-required'));
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
  mutators: AuthMutators,
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
  mutators.setToken(newToken);
  mutators.setAuthStatus('authenticated');
}

/** Register API-layer callbacks that bridge token state to the HTTP client. */
function useApiCallbacks(
  tokenRef: React.MutableRefObject<string | null>,
  mutators: AuthMutators,
): void {
  // BUG-FRONTEND-INFRA-013: hold the getter in a ref that outlives the effect
  // so a mid-request logout (which clears ``tokenRef.current``) can't lose
  // the reference before the HTTP client reads it. On unmount we explicitly
  // clear the getter so the stale closure is not left pinned in the module.
  const stableGetter = useCallback(() => tokenRef.current, [tokenRef]);

  useEffect(() => {
    setTokenGetter(stableGetter);
    setOnUnauthorized(() => {
      void clearTokenForReauth(mutators);
    });
    setOnTokenRefreshed((t: string) => {
      void saveTokenThenApply(t, mutators, tokenRef);
    });
    return () => {
      setTokenGetter(null);
      setOnUnauthorized(null);
      setOnTokenRefreshed(null);
    };
  }, [stableGetter, mutators, tokenRef]);
}

/**
 * Load token from storage on mount, discarding expired tokens. Terminates
 * in either ``'authenticated'`` or ``'anonymous'`` — ``'loading'`` is a
 * one-shot state, so later effects must not rewind it (BUG-NAV-002).
 */
function useLoadStoredToken(mutators: AuthMutators): void {
  useEffect(() => {
    loadToken()
      .then(async (stored) => {
        if (stored && !isTokenExpired(stored)) {
          mutators.setToken(stored);
          mutators.setAuthStatus('authenticated');
          return;
        }
        if (stored) {
          try {
            await clearToken();
          } catch (err: unknown) {
            console.warn('clearToken failed discarding expired stored token', err);
          }
        }
        mutators.setAuthStatus('anonymous');
      })
      .catch((err: unknown) => {
        console.warn('loadToken failed on bootstrap', err);
        mutators.setAuthStatus('anonymous');
      });
  }, [mutators]);
}

interface AuthActions {
  login: LoginOrSignup;
  signup: LoginOrSignup;
  logout: () => Promise<void>;
  onUnauthorized: () => void;
  dismissReauth: () => Promise<void>;
}

/**
 * POST /auth/signup with the device's IANA timezone attached.
 *
 * Captures the timezone here (not at the AuthContext call site) so the
 * `useAuthActions` hook stays under the max-lines lint threshold and so
 * the timezone capture lives next to its only call.  Closes the PR #260
 * review write-path gap: without this the `User.timezone` column would
 * remain at its `"UTC"` default for every signup.
 */
async function signupWithDeviceTimezone(email: string, password: string): Promise<string> {
  const response = await authApi.signup({
    email,
    password,
    timezone: detectDeviceTimezone(),
  });
  return response.token;
}

function useAuthActions(mutators: AuthMutators): AuthActions {
  const { setToken, setAuthStatus } = mutators;

  const login = useCallback<LoginOrSignup>(
    async (email, password) => {
      const response = await authApi.login({ email, password });
      await saveToken(response.token);
      setToken(response.token);
      setAuthStatus('authenticated');
    },
    [setToken, setAuthStatus],
  );

  const signup = useCallback<LoginOrSignup>(
    async (email, password) => {
      const token = await signupWithDeviceTimezone(email, password);
      await saveToken(token);
      setToken(token);
      setAuthStatus('authenticated');
    },
    [setToken, setAuthStatus],
  );

  const logout = useCallback(async () => {
    // BUG-FE-STATE-001 review follow-up: if SecureStore rejects we must still
    // null the in-memory token and wipe the stores — otherwise a flaky
    // device keychain leaves the app indefinitely authenticated.
    try {
      await clearToken();
    } catch (err: unknown) {
      console.warn('clearToken failed in logout', err);
    }
    await wipeUserState();
    setToken(null);
    setAuthStatus('anonymous');
  }, [setToken, setAuthStatus]);

  // BUG-AUTH-005: mirror the persistence-first ordering used by the API-layer
  // onUnauthorized hook so callers of the context-exposed helper get the same
  // crash-safety guarantee. Routes to ``'reauth-required'`` so RootStack
  // stays mounted (BUG-NAV-001).
  const onUnauthorized = useCallback(() => {
    void clearTokenForReauth(mutators);
  }, [mutators]);

  const dismissReauth = useCallback(async () => {
    try {
      await clearToken();
    } catch (err: unknown) {
      console.warn('clearToken failed in dismissReauth', err);
    }
    await wipeUserState();
    setToken(null);
    setAuthStatus('anonymous');
  }, [setToken, setAuthStatus]);

  // Memoize the bundle so the context value's ``useMemo`` actually short-
  // circuits on renders where none of the identity-stable callbacks changed.
  return useMemo(
    () => ({ login, signup, logout, onUnauthorized, dismissReauth }),
    [login, signup, logout, onUnauthorized, dismissReauth],
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');

  const tokenRef = React.useRef<string | null>(null);
  tokenRef.current = token;

  // Stable handle so effects depending on the mutators don't thrash.
  const mutators = useMemo<AuthMutators>(() => ({ setToken, setAuthStatus }), []);

  const applyNewToken = useCallback(async (newToken: string) => {
    await saveToken(newToken);
    setToken(newToken);
    setAuthStatus('authenticated');
  }, []);

  useApiCallbacks(tokenRef, mutators);
  useProactiveRefresh(token, tokenRef, applyNewToken);
  useLoadStoredToken(mutators);

  const actions = useAuthActions(mutators);
  const isLoading = authStatus === 'loading';

  const value = useMemo(
    () => ({ token, authStatus, isLoading, ...actions }),
    [token, authStatus, isLoading, actions],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
