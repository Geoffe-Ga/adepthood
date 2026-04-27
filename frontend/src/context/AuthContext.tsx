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
  /**
   * IANA timezone the server has on record for the authenticated user.
   * Populated from the `/auth/signup` / `/auth/login` / `/auth/refresh`
   * response so user-local helpers (Habit stats, streak, weekday charts)
   * can compute "today" in the user's calendar without an extra
   * `GET /users/me`.  Defaults to `"UTC"` while anonymous or before the
   * first auth response resolves -- which matches the helpers' own
   * default fallback so consumers never see a `null`-typed value.
   */
  userTimezone: string;
  login: LoginOrSignup;
  signup: LoginOrSignup;
  logout: () => Promise<void>;
  onUnauthorized: () => void;
  /** User dismissed the re-auth sheet: treat as an explicit logout. */
  dismissReauth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function silentRefresh(
  currentToken: string,
  onSuccess: (t: string, timezone: string | undefined) => void,
): void {
  authApi.refresh(currentToken).then(
    (res) => onSuccess(res.token, res.timezone),
    () => {
      /* silent fail — 401 retry is the fallback */
    },
  );
}

/** Schedule proactive token refresh before expiration. */
function useProactiveRefresh(
  token: string | null,
  tokenRef: React.MutableRefObject<string | null>,
  applyNewToken: (t: string, timezone: string | undefined) => void,
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
  setUserTimezone: React.Dispatch<React.SetStateAction<string>>;
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
  newTimezone: string | undefined,
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
  // PR #260 review round 3: propagate the server's stored timezone to the
  // auth context so a cold-start refresh restores the user's IANA zone
  // instead of leaving ``userTimezone`` at the ``"UTC"`` default.
  mutators.setUserTimezone(newTimezone ?? 'UTC');
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
    setOnTokenRefreshed((t: string, tz: string | undefined) => {
      void saveTokenThenApply(t, tz, mutators, tokenRef);
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
 * the timezone capture lives next to its only call.  Closes the
 * write-path gap: without this the `User.timezone` column would remain
 * at its `"UTC"` default for every signup.  Returns the signed token
 * plus the server's record of the stored zone (which the backend may
 * have normalised) so the AuthContext can populate `userTimezone`
 * synchronously with the same value the rest of the API will return.
 */
async function signupWithDeviceTimezone(
  email: string,
  password: string,
): Promise<{ token: string; timezone: string }> {
  const response = await authApi.signup({
    email,
    password,
    timezone: detectDeviceTimezone(),
  });
  return { token: response.token, timezone: response.timezone ?? 'UTC' };
}

/**
 * Shared "user logged out / session ended" tear-down used by both
 * ``logout`` and ``dismissReauth``.  Extracted so the ``useAuthActions``
 * hook stays under the 50-line max-lines lint cap; the BUG-FE-STATE-001
 * crash-safety contract (clearToken inside try/catch, then store wipe,
 * then clear in-memory state) lives here in one place rather than
 * duplicated across two callbacks.
 */
async function tearDownSession(mutators: AuthMutators, where: string): Promise<void> {
  try {
    await clearToken();
  } catch (err: unknown) {
    console.warn(`clearToken failed in ${where}`, err);
  }
  await wipeUserState();
  mutators.setToken(null);
  mutators.setUserTimezone('UTC');
  mutators.setAuthStatus('anonymous');
}

function useAuthActions(mutators: AuthMutators): AuthActions {
  const { setToken, setAuthStatus, setUserTimezone } = mutators;

  const login = useCallback<LoginOrSignup>(
    async (email, password) => {
      const response = await authApi.login({ email, password });
      await saveToken(response.token);
      setToken(response.token);
      setUserTimezone(response.timezone ?? 'UTC');
      setAuthStatus('authenticated');
    },
    [setToken, setAuthStatus, setUserTimezone],
  );

  const signup = useCallback<LoginOrSignup>(
    async (email, password) => {
      const { token, timezone } = await signupWithDeviceTimezone(email, password);
      await saveToken(token);
      setToken(token);
      setUserTimezone(timezone);
      setAuthStatus('authenticated');
    },
    [setToken, setAuthStatus, setUserTimezone],
  );

  const logout = useCallback(() => tearDownSession(mutators, 'logout'), [mutators]);

  // BUG-AUTH-005: mirror the persistence-first ordering used by the API-layer
  // onUnauthorized hook so callers of the context-exposed helper get the same
  // crash-safety guarantee. Routes to ``'reauth-required'`` so RootStack
  // stays mounted (BUG-NAV-001).
  const onUnauthorized = useCallback(() => {
    void clearTokenForReauth(mutators);
  }, [mutators]);

  const dismissReauth = useCallback(() => tearDownSession(mutators, 'dismissReauth'), [mutators]);

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
  // ``userTimezone`` defaults to ``"UTC"`` so consumers never see a null
  // value -- the same default the user-local helpers fall back to when
  // the column is unset, so behavior is identical across the brief
  // pre-auth window.
  const [userTimezone, setUserTimezone] = useState<string>('UTC');

  const tokenRef = React.useRef<string | null>(null);
  tokenRef.current = token;

  // Stable handle so effects depending on the mutators don't thrash.
  const mutators = useMemo<AuthMutators>(() => ({ setToken, setAuthStatus, setUserTimezone }), []);

  // PR #260 review round 3: ``applyNewToken`` now also accepts the
  // server's stored timezone from the refresh response so the cold-start
  // → proactive-refresh path keeps ``userTimezone`` aligned with the
  // authenticated user's IANA zone.  ``undefined`` falls back to UTC so
  // an old API build that omits the field still works.
  const applyNewToken = useCallback(async (newToken: string, newTimezone: string | undefined) => {
    await saveToken(newToken);
    setToken(newToken);
    setUserTimezone(newTimezone ?? 'UTC');
    setAuthStatus('authenticated');
  }, []);

  useApiCallbacks(tokenRef, mutators);
  useProactiveRefresh(token, tokenRef, applyNewToken);
  useLoadStoredToken(mutators);

  const actions = useAuthActions(mutators);
  const isLoading = authStatus === 'loading';

  const value = useMemo(
    () => ({ token, authStatus, isLoading, userTimezone, ...actions }),
    [token, authStatus, isLoading, userTimezone, actions],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
