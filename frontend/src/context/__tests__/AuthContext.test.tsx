/* eslint-env jest */
/* global describe, it, expect, beforeEach, afterEach, jest */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import React from 'react';

import { AuthProvider, useAuth } from '../AuthContext';

// Mock the API client
jest.mock('@/api', () => ({
  auth: {
    login: jest.fn(),
    signup: jest.fn(),
    refresh: jest.fn(),
  },
  setTokenGetter: jest.fn(),
  setOnUnauthorized: jest.fn(),
  setOnTokenRefreshed: jest.fn(),
}));

// Mock authStorage
jest.mock('@/storage/authStorage', () => ({
  saveToken: jest.fn(() => Promise.resolve()),
  loadToken: jest.fn(() => Promise.resolve(null)),
  clearToken: jest.fn(() => Promise.resolve()),
}));

// Mock token utilities
jest.mock('@/utils/token', () => ({
  decodeJwtPayload: jest.fn(() => null),
  isTokenExpired: jest.fn(() => false),
  shouldRefreshToken: jest.fn(() => false),
  REFRESH_BUFFER_SECONDS: 300,
}));

import { auth, setOnTokenRefreshed, setOnUnauthorized, setTokenGetter } from '@/api';
import { saveToken, loadToken, clearToken } from '@/storage/authStorage';
import { isTokenExpired, shouldRefreshToken } from '@/utils/token';

const mockAuth = auth as jest.Mocked<typeof auth>;
const mockLoadToken = loadToken as jest.MockedFunction<typeof loadToken>;
const mockSaveToken = saveToken as jest.MockedFunction<typeof saveToken>;
const mockClearToken = clearToken as jest.MockedFunction<typeof clearToken>;
const mockSetTokenGetter = setTokenGetter as jest.MockedFunction<typeof setTokenGetter>;
const mockSetOnTokenRefreshed = setOnTokenRefreshed as jest.MockedFunction<
  typeof setOnTokenRefreshed
>;
const mockSetOnUnauthorized = setOnUnauthorized as jest.MockedFunction<typeof setOnUnauthorized>;
const mockIsTokenExpired = isTokenExpired as jest.MockedFunction<typeof isTokenExpired>;
const mockShouldRefreshToken = shouldRefreshToken as jest.MockedFunction<typeof shouldRefreshToken>;

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockLoadToken.mockResolvedValue(null);
  mockIsTokenExpired.mockReturnValue(false);
  mockShouldRefreshToken.mockReturnValue(false);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AuthContext', () => {
  describe('initial state', () => {
    it('starts with isLoading true while checking stored token', () => {
      // Never resolve loadToken so we stay in loading state
      mockLoadToken.mockReturnValue(new Promise(() => {}));
      const { result } = renderHook(() => useAuth(), { wrapper });

      expect(result.current.isLoading).toBe(true);
      expect(result.current.token).toBeNull();
    });

    it('finishes loading with no user when no stored token', async () => {
      mockLoadToken.mockResolvedValue(null);
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.token).toBeNull();
    });

    it('restores token from secure storage on mount', async () => {
      mockLoadToken.mockResolvedValue('stored-jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.token).toBe('stored-jwt');
    });

    it('registers token getter with API client on mount', async () => {
      mockLoadToken.mockResolvedValue('stored-jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(mockSetTokenGetter).toHaveBeenCalled();
      // Call the registered getter to verify it returns the token
      const getter = mockSetTokenGetter.mock.calls[0]![0] as () => string | null;
      expect(getter()).toBe('stored-jwt');
    });
  });

  describe('login', () => {
    it('calls API login and stores token on success', async () => {
      mockAuth.login.mockResolvedValue({ token: 'new-jwt', user_id: 1 });
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.login('user@test.com', 'password123');
      });

      expect(mockAuth.login).toHaveBeenCalledWith({
        email: 'user@test.com',
        password: 'password123', // pragma: allowlist secret
      });
      expect(mockSaveToken).toHaveBeenCalledWith('new-jwt');
      expect(result.current.token).toBe('new-jwt');
    });

    it('propagates API errors on login failure', async () => {
      mockAuth.login.mockRejectedValue(new Error('Invalid credentials'));
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await expect(
        act(async () => {
          await result.current.login('user@test.com', 'wrong');
        }),
      ).rejects.toThrow('Invalid credentials');

      expect(result.current.token).toBeNull();
      expect(mockSaveToken).not.toHaveBeenCalled();
    });
  });

  describe('signup', () => {
    it('calls API signup and stores token on success', async () => {
      mockAuth.signup.mockResolvedValue({ token: 'signup-jwt', user_id: 2 });
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.signup('new@test.com', 'password123');
      });

      expect(mockAuth.signup).toHaveBeenCalledWith({
        email: 'new@test.com',
        password: 'password123', // pragma: allowlist secret
      });
      expect(mockSaveToken).toHaveBeenCalledWith('signup-jwt');
      expect(result.current.token).toBe('signup-jwt');
    });
  });

  describe('logout', () => {
    it('clears token from state and storage', async () => {
      mockLoadToken.mockResolvedValue('existing-jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.token).toBe('existing-jwt'));

      await act(async () => {
        await result.current.logout();
      });

      expect(mockClearToken).toHaveBeenCalled();
      expect(result.current.token).toBeNull();
    });
  });

  describe('onUnauthorized', () => {
    it('clears auth state when called (for 401 handling)', async () => {
      mockLoadToken.mockResolvedValue('existing-jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.token).toBe('existing-jwt'));

      await act(async () => {
        result.current.onUnauthorized();
      });

      expect(mockClearToken).toHaveBeenCalled();
      expect(result.current.token).toBeNull();
    });
  });

  // BUG-NAV-001 / BUG-NAV-002: the navigator must discriminate between
  // "transient 401, ask to re-auth" and "user is anonymous" — otherwise
  // any 401 during a tab switch unmounts BottomTabs and boots the user
  // to Signup. The machine also guards against re-entering ``'loading'``
  // mid-session: once bootstrap settles we never rewind.
  describe('authStatus state machine (BUG-NAV-001 / BUG-NAV-002)', () => {
    it("starts in 'loading' before the stored-token read resolves", () => {
      mockLoadToken.mockReturnValue(new Promise(() => {}));
      const { result } = renderHook(() => useAuth(), { wrapper });
      expect(result.current.authStatus).toBe('loading');
    });

    it("resolves to 'anonymous' when no token is stored", async () => {
      mockLoadToken.mockResolvedValue(null);
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.authStatus).toBe('anonymous'));
    });

    it("resolves to 'authenticated' when a valid token is stored", async () => {
      mockLoadToken.mockResolvedValue('valid-jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));
    });

    it("resolves to 'anonymous' when the stored token is expired", async () => {
      mockLoadToken.mockResolvedValue('expired-jwt');
      mockIsTokenExpired.mockReturnValue(true);
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.authStatus).toBe('anonymous'));
    });

    it("transitions to 'authenticated' after successful login", async () => {
      mockAuth.login.mockResolvedValue({ token: 'new-jwt', user_id: 1 });
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.authStatus).toBe('anonymous'));

      await act(async () => {
        await result.current.login('user@test.com', 'password123');
      });
      expect(result.current.authStatus).toBe('authenticated');
    });

    it("transitions to 'reauth-required' on onUnauthorized (NOT 'anonymous')", async () => {
      mockLoadToken.mockResolvedValue('stored-jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));

      await act(async () => {
        result.current.onUnauthorized();
      });
      await waitFor(() => expect(result.current.authStatus).toBe('reauth-required'));
      // Explicitly not 'anonymous' — that would unmount RootStack.
      expect(result.current.authStatus).not.toBe('anonymous');
    });

    it("transitions to 'anonymous' on explicit logout", async () => {
      mockLoadToken.mockResolvedValue('stored-jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));

      await act(async () => {
        await result.current.logout();
      });
      expect(result.current.authStatus).toBe('anonymous');
    });

    it("does not re-enter 'loading' after bootstrap completes", async () => {
      mockLoadToken.mockResolvedValue(null);
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.authStatus).toBe('anonymous'));

      mockAuth.login.mockResolvedValue({ token: 'new-jwt', user_id: 1 });
      await act(async () => {
        await result.current.login('user@test.com', 'p'); // pragma: allowlist secret
      });
      expect(result.current.authStatus).toBe('authenticated');

      await act(async () => {
        result.current.onUnauthorized();
      });
      // Still not 'loading' — we never rewind the one-shot bootstrap flag.
      await waitFor(() => expect(result.current.authStatus).toBe('reauth-required'));
      expect(result.current.authStatus).not.toBe('loading');
    });

    it("dismissReauth transitions from 'reauth-required' to 'anonymous'", async () => {
      mockLoadToken.mockResolvedValue('stored-jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));

      await act(async () => {
        result.current.onUnauthorized();
      });
      await waitFor(() => expect(result.current.authStatus).toBe('reauth-required'));

      await act(async () => {
        await result.current.dismissReauth();
      });
      expect(result.current.authStatus).toBe('anonymous');
    });

    it("isLoading mirrors authStatus === 'loading' for backwards compatibility", () => {
      mockLoadToken.mockReturnValue(new Promise(() => {}));
      const { result } = renderHook(() => useAuth(), { wrapper });
      expect(result.current.isLoading).toBe(true);
      expect(result.current.authStatus).toBe('loading');
    });
  });

  describe('token expiration on startup', () => {
    it('discards an expired stored token', async () => {
      mockLoadToken.mockResolvedValue('expired-jwt');
      mockIsTokenExpired.mockReturnValue(true);

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.token).toBeNull();
      expect(mockClearToken).toHaveBeenCalled();
    });

    it('keeps a non-expired stored token', async () => {
      mockLoadToken.mockResolvedValue('valid-jwt');
      mockIsTokenExpired.mockReturnValue(false);

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.token).toBe('valid-jwt');
      expect(mockClearToken).not.toHaveBeenCalled();
    });
  });

  describe('api-layer token callbacks (BUG-AUTH-001 / BUG-AUTH-005)', () => {
    it('awaits saveToken before updating state when API refresh fires', async () => {
      mockLoadToken.mockResolvedValue('old-jwt');
      let resolveSave: (() => void) | null = null;
      mockSaveToken.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          }),
      );

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.token).toBe('old-jwt'));

      // Grab the callback that the AuthProvider registered with the API layer.
      const refreshed = mockSetOnTokenRefreshed.mock.calls.at(-1)?.[0];
      expect(typeof refreshed).toBe('function');

      await act(async () => {
        refreshed?.('fresh-jwt');
      });

      // Save is in-flight — state must not have flipped yet.
      expect(mockSaveToken).toHaveBeenCalledWith('fresh-jwt');
      expect(result.current.token).toBe('old-jwt');

      await act(async () => {
        resolveSave?.();
      });

      await waitFor(() => expect(result.current.token).toBe('fresh-jwt'));
    });

    it('awaits clearToken before nulling state when API reports 401', async () => {
      mockLoadToken.mockResolvedValue('stored-jwt');
      let resolveClear: (() => void) | null = null;
      mockClearToken.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveClear = resolve;
          }),
      );

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.token).toBe('stored-jwt'));

      const unauthorized = mockSetOnUnauthorized.mock.calls.at(-1)?.[0];
      expect(typeof unauthorized).toBe('function');

      await act(async () => {
        unauthorized?.();
      });

      // Clear is in-flight — state must not have flipped yet.
      expect(mockClearToken).toHaveBeenCalled();
      expect(result.current.token).toBe('stored-jwt');

      await act(async () => {
        resolveClear?.();
      });

      await waitFor(() => expect(result.current.token).toBeNull());
    });
  });

  describe('proactive token refresh', () => {
    it('refreshes immediately when token is within the refresh buffer', async () => {
      mockLoadToken.mockResolvedValue('near-expiry-jwt');
      mockIsTokenExpired.mockReturnValue(false);
      mockShouldRefreshToken.mockReturnValue(true);
      mockAuth.refresh.mockResolvedValue({ token: 'refreshed-jwt', user_id: 1 });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.token).toBe('refreshed-jwt'));

      expect(mockAuth.refresh).toHaveBeenCalledWith('near-expiry-jwt');
      expect(mockSaveToken).toHaveBeenCalledWith('refreshed-jwt');
    });

    it('does not crash when proactive refresh fails', async () => {
      mockLoadToken.mockResolvedValue('near-expiry-jwt');
      mockIsTokenExpired.mockReturnValue(false);
      mockShouldRefreshToken.mockReturnValue(true);
      mockAuth.refresh.mockRejectedValue(new Error('network error'));

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Token should remain as-is when refresh fails
      expect(result.current.token).toBe('near-expiry-jwt');
    });

    // BUG-FRONTEND-INFRA-020: assert we set a timer tied to
    // ``exp - REFRESH_BUFFER_SECONDS`` and only fire ``silentRefresh`` once
    // when that deadline passes — not on every re-render or auth-state tick.
    it('fires silentRefresh exactly once when the REFRESH_BUFFER_SECONDS deadline elapses', async () => {
      mockLoadToken.mockResolvedValue('fresh-jwt');
      mockIsTokenExpired.mockReturnValue(false);
      mockShouldRefreshToken.mockReturnValue(false);
      const nowSec = Math.floor(Date.now() / 1000);
      // Expires 10 minutes from now — REFRESH_BUFFER_SECONDS (5m) before
      // that is 5 minutes from now; advancing fake timers past that mark
      // should trigger exactly one refresh call.
      (
        require('@/utils/token') as { decodeJwtPayload: jest.Mock }
      ).decodeJwtPayload.mockReturnValue({
        exp: nowSec + 600,
      });
      mockAuth.refresh.mockResolvedValue({ token: 'refreshed-jwt', user_id: 1 });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.token).toBe('fresh-jwt'));

      // Not yet past the buffer → no refresh.
      expect(mockAuth.refresh).not.toHaveBeenCalled();

      await act(async () => {
        // Advance past the scheduled refresh point (5 minutes + 1s).
        jest.advanceTimersByTime(5 * 60 * 1000 + 1000);
      });

      await waitFor(() => expect(mockAuth.refresh).toHaveBeenCalledTimes(1));
    });
  });

  // BUG-FRONTEND-INFRA-012: logout edge cases. The single integration test
  // documented here exercises the full logout lifecycle rather than spot-
  // checking internals — matching how users actually hit these paths.
  describe('logout lifecycle (BUG-012)', () => {
    it('handles back-to-back logout calls without double-clearing', async () => {
      mockLoadToken.mockResolvedValue('existing-jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.token).toBe('existing-jwt'));

      await act(async () => {
        await Promise.all([result.current.logout(), result.current.logout()]);
      });

      expect(result.current.token).toBeNull();
      expect(mockClearToken).toHaveBeenCalled();
    });

    it('survives a logout that fires while a token refresh is in flight', async () => {
      mockLoadToken.mockResolvedValue('existing-jwt');
      let resolveRefresh: ((value: { token: string; user_id: number }) => void) | null = null;
      mockAuth.refresh.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.token).toBe('existing-jwt'));

      const refreshed = mockSetOnTokenRefreshed.mock.calls.at(-1)?.[0];
      await act(async () => {
        await result.current.logout();
      });
      expect(result.current.token).toBeNull();

      // Mid-flight refresh completes AFTER logout — do not resurrect the session.
      await act(async () => {
        resolveRefresh?.({ token: 'late-jwt', user_id: 1 });
        refreshed?.('late-jwt');
      });
      await waitFor(() => expect(result.current.token).toBeNull());
    });

    it('cleanly round-trips logout → login in a single session', async () => {
      mockLoadToken.mockResolvedValue('first-jwt');
      mockAuth.login.mockResolvedValue({ token: 'second-jwt', user_id: 2 });
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.token).toBe('first-jwt'));
      await act(async () => {
        await result.current.logout();
      });
      expect(result.current.token).toBeNull();

      await act(async () => {
        await result.current.login('new@test.com', 'p'); // pragma: allowlist secret
      });
      expect(result.current.token).toBe('second-jwt');
    });
  });

  // BUG-FE-STATE-001: every logout path — explicit logout and the re-auth
  // sheet's "sign out instead" button — must wipe the in-memory stores AND
  // the AsyncStorage keys that act as persistent caches so the next user on
  // the device doesn't inherit the previous user's data.
  describe('logout clears all user state (BUG-FE-STATE-001)', () => {
    it('calls resetAllStores from the registry on explicit logout', async () => {
      const { resetAllStores } = require('@/store/registry');
      const resetSpy = jest.spyOn(require('@/store/registry'), 'resetAllStores');
      mockLoadToken.mockResolvedValue('jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.token).toBe('jwt'));

      await act(async () => {
        await result.current.logout();
      });

      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(typeof resetAllStores).toBe('function');
      resetSpy.mockRestore();
    });

    it('calls resetAllStores when the user dismisses the re-auth sheet', async () => {
      const resetSpy = jest.spyOn(require('@/store/registry'), 'resetAllStores');
      mockLoadToken.mockResolvedValue('jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.token).toBe('jwt'));

      await act(async () => {
        await result.current.dismissReauth();
      });

      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(result.current.authStatus).toBe('anonymous');
      resetSpy.mockRestore();
    });

    it('does NOT reset stores on a 401-triggered reauth-required transition', async () => {
      // A 401 is a hint that the session went stale, not that the user is
      // done with the app. Keep their in-memory habits/stages around so the
      // ReauthSheet feels like a single-modal interruption, not a logout.
      const resetSpy = jest.spyOn(require('@/store/registry'), 'resetAllStores');
      mockLoadToken.mockResolvedValue('jwt');
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.token).toBe('jwt'));

      await act(async () => {
        result.current.onUnauthorized();
      });

      await waitFor(() => expect(result.current.authStatus).toBe('reauth-required'));
      expect(resetSpy).not.toHaveBeenCalled();
      resetSpy.mockRestore();
    });
  });
});
