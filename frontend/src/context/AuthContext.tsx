import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  auth as authApi,
  setOnTokenRefreshed,
  setOnUnauthorized,
  setTokenGetter,
  type AuthResponse,
  type UnauthorizedReason,
} from '@/api';
import {
  clearLogoutPending,
  clearToken,
  isLogoutPending,
  loadToken,
  markLogoutPending,
  saveToken,
} from '@/storage/authStorage';
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

type ConfirmReset = (_token: string, _newPassword: string) => Promise<void>;

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
  /**
   * Push a server-confirmed IANA zone into ``userTimezone`` (issue #261).
   * Call this ONLY with the zone echoed back by ``PUT /users/me/timezone``
   * so the context never drifts from what the backend has on record —
   * client-side guesses belong in the request, not here.
   */
  setUserTimezone: (_timezone: string) => void;
  login: LoginOrSignup;
  signup: LoginOrSignup;
  logout: () => Promise<void>;
  onUnauthorized: () => void;
  /** User dismissed the re-auth sheet: treat as an explicit logout. */
  dismissReauth: () => Promise<void>;
  /**
   * Complete a password reset by trading a single-use token for a
   * fresh AuthResponse and landing the device in ``authenticated``
   * state.  Re-uses the same persistence-then-state ordering as
   * ``login`` (BUG-AUTH-005) via the ``applyAuthResponse`` helper.
   */
  confirmPasswordReset: ConfirmReset;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function silentRefresh(
  currentToken: string,
  onSuccess: (t: string, timezone: string | undefined, expectedPriorToken: string) => void,
): void {
  authApi.refresh(currentToken).then(
    (res) => onSuccess(res.token, res.timezone, currentToken),
    () => {
      /* silent fail — 401 retry is the fallback */
    },
  );
}

/** Schedule proactive token refresh before expiration. */
function useProactiveRefresh(
  token: string | null,
  tokenRef: React.MutableRefObject<string | null>,
  applyNewToken: (t: string, timezone: string | undefined, expectedPriorToken: string) => void,
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
 * Best-effort ``clearToken`` shared by every teardown path. Returns ``true``
 * when the delete succeeded and ``false`` when it rejected (warned inside), so
 * the caller can decide whether to arm the BUG-FE-STATE-001 logout-pending
 * marker.
 */
async function clearTokenSafely(label: string): Promise<boolean> {
  try {
    await clearToken();
    return true;
  } catch (err: unknown) {
    console.warn(`clearToken failed in ${label}`, err);
    return false;
  }
}

/**
 * BUG-FE-STATE-001: a logout/401 clear that failed left the JWT on disk to
 * resurrect on cold start. Arm the logout-pending marker (best-effort) so the
 * next bootstrap retries the delete before hydrating.
 */
async function armLogoutPending(label: string): Promise<void> {
  try {
    await markLogoutPending();
  } catch (err: unknown) {
    console.warn(`markLogoutPending failed in ${label}`, err);
  }
}

/**
 * BUG-AUTH-005 / BUG-NAV-001: the storage write must complete before we drop
 * the token from state; otherwise a crash between the two leaves a stale
 * token in secure storage that hydrates on next launch. When the API layer
 * reports 401 we transition to ``'reauth-required'`` (so the navigator keeps
 * Tabs mounted), not ``'anonymous'``.
 *
 * BUG-API-018: ``reason`` is the structured 401 cause forwarded by the API
 * client.  ``'not_authenticated'`` means an anonymous request hit a
 * protected endpoint -- the user never had a session, so we collapse to
 * ``'anonymous'`` rather than showing the misleading "session expired"
 * re-auth sheet.  ``'session_expired'`` and ``'invalid_token'`` keep the
 * existing re-auth flow.
 */
async function clearTokenForReauth(
  mutators: AuthMutators,
  reason: UnauthorizedReason,
): Promise<void> {
  if (!(await clearTokenSafely('onUnauthorized'))) {
    await armLogoutPending('onUnauthorized');
  }
  mutators.setToken(null);
  mutators.setAuthStatus((prev) => {
    if (prev === 'loading') return 'anonymous';
    if (reason === 'not_authenticated') return 'anonymous';
    return 'reauth-required';
  });
}

/**
 * BUG-AUTH-001: a fire-and-forget saveToken loses the refreshed token if
 * the app is killed between the refresh response and the secure-storage
 * write. Await the persistence before surfacing the token to React state.
 *
 * BUG-FRONTEND-INFRA-012: identity-guard the write against the exact token
 * the refresh was issued FOR. Apply the new token only while
 * ``tokenRef.current`` still equals ``expectedPriorToken`` (re-checked after
 * the async save). This drops a late refresh after a plain logout (ref is
 * null) AND a stale refresh of a prior session after logout->re-login (ref
 * holds the new session token), so a stale refresh can never clobber a
 * fresh login in React state.
 */
async function saveTokenThenApply(
  newToken: string,
  newTimezone: string | undefined,
  mutators: AuthMutators,
  tokenRef: React.MutableRefObject<string | null>,
  warnLabel: string,
  expectedPriorToken: string,
): Promise<void> {
  if (tokenRef.current !== expectedPriorToken) {
    // Logout or a re-login won the race — drop the stale refresh response.
    return;
  }
  try {
    await saveToken(newToken);
  } catch (err: unknown) {
    console.warn(`saveToken failed in ${warnLabel}`, err);
    return;
  }
  if (tokenRef.current !== expectedPriorToken) return;
  mutators.setToken(newToken);
  // Refresh responses carry the user's stored IANA zone so a cold-start
  // → proactive-refresh sequence restores ``userTimezone`` without an
  // extra ``GET /users/me`` round-trip.  ``undefined`` falls back to
  // UTC so a legacy API build that omits the field still works.
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
    setOnUnauthorized((reason: UnauthorizedReason) => {
      void clearTokenForReauth(mutators, reason);
    });
    setOnTokenRefreshed((t: string, tz: string | undefined, prior: string) => {
      void saveTokenThenApply(t, tz, mutators, tokenRef, 'onTokenRefreshed', prior);
    });
    return () => {
      setTokenGetter(null);
      setOnUnauthorized(null);
      setOnTokenRefreshed(null);
    };
  }, [stableGetter, mutators, tokenRef]);
}

/**
 * BUG-FE-STATE-001: a prior logout/401 armed the marker because ``clearToken``
 * failed, stranding the JWT on disk. Retry the delete now; disarm the marker
 * only if the retry succeeds so a still-failing store is tried again next
 * launch. Either way the session lands ``'anonymous'``.
 */
async function drainPendingLogout(mutators: AuthMutators): Promise<void> {
  if (await clearTokenSafely('bootstrap')) {
    try {
      await clearLogoutPending();
    } catch (err: unknown) {
      console.warn('clearLogoutPending failed on bootstrap', err);
    }
  }
  mutators.setAuthStatus('anonymous');
}

/**
 * Cold-start bootstrap: honor a pending logout before hydrating, then load the
 * stored token and discard it if expired. Terminates in ``'authenticated'`` or
 * ``'anonymous'`` — ``'loading'`` is one-shot, so later effects must not rewind
 * it (BUG-NAV-002).
 */
async function bootstrapStoredToken(mutators: AuthMutators): Promise<void> {
  if (await isLogoutPending()) {
    await drainPendingLogout(mutators);
    return;
  }
  const stored = await loadToken();
  if (stored && !isTokenExpired(stored)) {
    mutators.setToken(stored);
    mutators.setAuthStatus('authenticated');
    return;
  }
  if (stored) {
    // Expired token: discard without arming the marker — the user did not ask
    // to log out, so a failed clear should not force a wipe next launch.
    await clearTokenSafely('bootstrap discard expired');
  }
  mutators.setAuthStatus('anonymous');
}

function useLoadStoredToken(mutators: AuthMutators): void {
  useEffect(() => {
    bootstrapStoredToken(mutators).catch((err: unknown) => {
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
  confirmPasswordReset: ConfirmReset;
}

/**
 * Persist the token, then propagate it (and the server's stored
 * timezone) into React state and flip ``authStatus`` to authenticated.
 *
 * Extracted so login / signup / password-reset all share the same
 * BUG-AUTH-005 persistence-first ordering: a crash between the
 * storage write and the state update leaves the next launch in a
 * recoverable place rather than holding a token in memory that the
 * device storage knows nothing about.
 */
async function applyAuthResponse(response: AuthResponse, mutators: AuthMutators): Promise<void> {
  await saveToken(response.token);
  // BUG-FE-STATE-001: a fresh auth supersedes any stale pending-logout marker;
  // a clear failure here must not break login / signup / password-reset.
  try {
    await clearLogoutPending();
  } catch (err: unknown) {
    console.warn('clearLogoutPending failed in applyAuthResponse', err);
  }
  mutators.setToken(response.token);
  mutators.setUserTimezone(response.timezone ?? 'UTC');
  mutators.setAuthStatus('authenticated');
}

/** Sentinel user_id in the backend's anti-enumeration duplicate-signup response (see schemas.ts:57, BUG-AUTH-002). */
const DUPLICATE_SIGNUP_SENTINEL_USER_ID = 0;

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
async function signupWithDeviceTimezone(email: string, password: string): Promise<AuthResponse> {
  const response = await authApi.signup({
    email,
    password,
    timezone: detectDeviceTimezone(),
  });
  if (response.user_id === DUPLICATE_SIGNUP_SENTINEL_USER_ID) {
    throw new ApiError(409, 'email_in_use');
  }
  return response;
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
  if (!(await clearTokenSafely(where))) {
    await armLogoutPending(where);
  }
  await wipeUserState();
  mutators.setToken(null);
  mutators.setUserTimezone('UTC');
  mutators.setAuthStatus('anonymous');
}

function useAuthActions(mutators: AuthMutators): AuthActions {
  const login = useCallback<LoginOrSignup>(
    async (email, password) => {
      const response = await authApi.login({ email, password });
      await applyAuthResponse(response, mutators);
    },
    [mutators],
  );

  const signup = useCallback<LoginOrSignup>(
    async (email, password) => {
      const response = await signupWithDeviceTimezone(email, password);
      await applyAuthResponse(response, mutators);
    },
    [mutators],
  );

  const logout = useCallback(() => tearDownSession(mutators, 'logout'), [mutators]);

  // BUG-AUTH-005: mirror the persistence-first ordering used by the API-layer
  // onUnauthorized hook so callers of the context-exposed helper get the same
  // crash-safety guarantee. Routes to ``'reauth-required'`` so RootStack
  // stays mounted (BUG-NAV-001).  Defaults to ``'session_expired'`` because
  // a manual ``onUnauthorized()`` call from app code always implies that
  // we *had* a token that the server then rejected.
  const onUnauthorized = useCallback(() => {
    void clearTokenForReauth(mutators, 'session_expired');
  }, [mutators]);

  const dismissReauth = useCallback(() => tearDownSession(mutators, 'dismissReauth'), [mutators]);

  const confirmPasswordReset = useCallback<ConfirmReset>(
    async (token, newPassword) => {
      const response = await authApi.confirmPasswordReset({
        token,
        new_password: newPassword,
      });
      await applyAuthResponse(response, mutators);
    },
    [mutators],
  );

  // Memoize the bundle so the context value's ``useMemo`` actually short-
  // circuits on renders where none of the identity-stable callbacks changed.
  return useMemo(
    () => ({ login, signup, logout, onUnauthorized, dismissReauth, confirmPasswordReset }),
    [login, signup, logout, onUnauthorized, dismissReauth, confirmPasswordReset],
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

  // ``applyNewToken`` accepts the server's stored timezone from the
  // refresh response so the cold-start → proactive-refresh path keeps
  // ``userTimezone`` aligned with the authenticated user's IANA zone.
  // ``undefined`` falls back to UTC so a legacy API build that omits
  // the field still works.
  //
  // ``expectedPriorToken`` is the token the proactive refresh was issued
  // for; ``saveTokenThenApply`` applies the result only while
  // ``tokenRef.current`` still equals it, so a logout OR a logout->re-login
  // that wins the race against the refresh does NOT resurrect a prior
  // session by re-applying its stale token.
  const applyNewToken = useCallback(
    async (newToken: string, newTimezone: string | undefined, expectedPriorToken: string) => {
      await saveTokenThenApply(
        newToken,
        newTimezone,
        mutators,
        tokenRef,
        'applyNewToken',
        expectedPriorToken,
      );
    },
    [mutators],
  );

  useApiCallbacks(tokenRef, mutators);
  useProactiveRefresh(token, tokenRef, applyNewToken);
  useLoadStoredToken(mutators);

  const actions = useAuthActions(mutators);
  const isLoading = authStatus === 'loading';

  const value = useMemo(
    () => ({ token, authStatus, isLoading, userTimezone, setUserTimezone, ...actions }),
    [token, authStatus, isLoading, userTimezone, actions],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
