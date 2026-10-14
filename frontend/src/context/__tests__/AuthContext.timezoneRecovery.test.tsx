import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { AuthProvider, useAuth } from '../AuthContext';

import { refreshSessionToken } from '@/api';
import { loadToken, loadUserTimezone, saveToken, saveUserTimezone } from '@/storage/authStorage';
import { setActiveUser } from '@/storage/userScope';
import { shouldRefreshToken } from '@/utils/token';

jest.mock('@/api', () => ({
  auth: {},
  refreshSessionToken: jest.fn(),
  resetLlmApiKey: jest.fn(),
  resetTokenRotations: jest.fn(),
  setOnTokenRefreshed: jest.fn(),
  setOnUnauthorized: jest.fn(),
  setTokenGetter: jest.fn(),
}));
jest.mock('@/storage/authStorage', () => ({
  saveToken: jest.fn(),
  loadToken: jest.fn(),
  clearToken: jest.fn(() => Promise.resolve()),
  markLogoutPending: jest.fn(() => Promise.resolve()),
  isLogoutPending: jest.fn(() => Promise.resolve(false)),
  clearLogoutPending: jest.fn(() => Promise.resolve()),
  saveUserTimezone: jest.fn(() => Promise.resolve()),
  loadUserTimezone: jest.fn(),
  clearUserTimezone: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/utils/token', () => ({
  decodeJwtPayload: jest.fn(() => null),
  isTokenExpired: jest.fn(() => false),
  shouldRefreshToken: jest.fn(() => false),
  refreshDeadlineMs: jest.fn(),
}));
const mockLoadToken = jest.mocked(loadToken);
const mockLoadUserTimezone = jest.mocked(loadUserTimezone);
const mockSaveToken = jest.mocked(saveToken);
const mockSaveUserTimezone = jest.mocked(saveUserTimezone);
const mockRefreshSession = jest.mocked(refreshSessionToken);
function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockLoadToken.mockResolvedValue(null);
  mockLoadUserTimezone.mockResolvedValue(null);
  mockSaveToken.mockResolvedValue(undefined);
  mockRefreshSession.mockReset();
  mockRefreshSession.mockRejectedValue(new Error('offline'));
  jest.mocked(shouldRefreshToken).mockReturnValue(false);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  setActiveUser(null);
});

describe('resumed timezone recovery (#3175)', () => {
  it('keeps the legacy missing-zone response contract without another refresh after rotation', async () => {
    mockLoadToken.mockResolvedValue('stored-jwt');
    mockRefreshSession.mockResolvedValue({ token: 'rotated-jwt', user_id: 7 });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.token).toBe('rotated-jwt'));
    expect(result.current.userTimezone).toBe('UTC');
    expect(result.current.userTimezoneReady).toBe(true);
    await act(async () => {
      await result.current.recoverUserTimezone();
      jest.advanceTimersByTime(60_000);
      await result.current.recoverUserTimezone();
    });
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  });

  it('retries a failed initial proactive refresh after the cooldown', async () => {
    mockLoadToken.mockResolvedValue('stored-jwt');
    jest.mocked(shouldRefreshToken).mockImplementation((token) => token === 'stored-jwt');
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(mockRefreshSession).toHaveBeenCalledTimes(1));
    expect(result.current.userTimezoneReady).toBe(false);
    mockRefreshSession.mockResolvedValue({ token: 'new-jwt', user_id: 7, timezone: 'UTC' });
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await result.current.recoverUserTimezone();
    });
    expect(mockRefreshSession).toHaveBeenCalledTimes(2);
    expect(result.current.userTimezoneReady).toBe(true);
  });

  it.each(['owner switch', 'unmount'])('drops a late recovery after %s', async (ending) => {
    mockLoadToken.mockResolvedValue('stored-jwt');
    const hook = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(mockRefreshSession).toHaveBeenCalledTimes(1));
    let finish!: (_value: { token: string; user_id: number; timezone: string }) => void;
    mockRefreshSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let recovery!: Promise<void>;
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      recovery = hook.result.current.recoverUserTimezone();
    });
    if (ending === 'owner switch') setActiveUser(2);
    else hook.unmount();
    await act(async () => {
      finish({ token: 'stale-jwt', user_id: 7, timezone: 'America/Los_Angeles' });
      await recovery;
    });
    expect(mockSaveToken).not.toHaveBeenCalled();
    expect(mockSaveUserTimezone).not.toHaveBeenCalled();
  });

  it.each(['UTC', 'America/Los_Angeles'])(
    'recovers offline timezone backfill on a later load (%s)',
    async (timezone) => {
      mockLoadToken.mockResolvedValue('stored-jwt');
      mockLoadUserTimezone.mockResolvedValue(null);
      mockRefreshSession.mockRejectedValueOnce(new Error('offline'));
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(mockRefreshSession).toHaveBeenCalledTimes(1));
      expect(result.current.userTimezoneReady).toBe(false);
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      mockRefreshSession.mockResolvedValue({ token: 'recovered-jwt', user_id: 7, timezone });
      await act(async () => {
        await result.current.recoverUserTimezone();
      });
      expect(result.current.userTimezone).toBe(timezone);
      expect(result.current.userTimezoneReady).toBe(true);
      expect(result.current.authStatus).toBe('authenticated');
      expect(mockSaveUserTimezone).toHaveBeenCalledWith(timezone);
    },
  );

  it('coalesces recovery callers and respects the one-minute cooldown without a retry timer', async () => {
    mockLoadToken.mockResolvedValue('stored-jwt');
    mockLoadUserTimezone.mockResolvedValue(null);
    let firstAttemptAt = 0;
    mockRefreshSession.mockImplementationOnce(async () => {
      firstAttemptAt = Date.now();
      throw new Error('offline');
    });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(mockRefreshSession).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.all([
        result.current.recoverUserTimezone(),
        result.current.recoverUserTimezone(),
      ]);
      jest.setSystemTime(firstAttemptAt + 59_999);
      await result.current.recoverUserTimezone();
    });
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.setSystemTime(firstAttemptAt + 60_000);
    });
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    let finish!: (_value: { token: string; user_id: number; timezone: string }) => void;
    mockRefreshSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let recovery!: Promise<void>;
    await act(async () => {
      recovery = result.current.recoverUserTimezone();
      await result.current.recoverUserTimezone();
    });
    expect(mockRefreshSession).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish({ token: 'recovered-jwt', user_id: 7, timezone: 'UTC' });
      await recovery;
    });
    expect(result.current.userTimezoneReady).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await result.current.recoverUserTimezone();
    });
    expect(mockRefreshSession).toHaveBeenCalledTimes(2);
  });

  it('recovers on foreground and drops a late recovery after logout', async () => {
    let foreground!: (_state: AppStateStatus) => void;
    const listener = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, handler) => {
        foreground = handler;
        return { remove: jest.fn() };
      });
    mockLoadToken.mockResolvedValue('stored-jwt');
    mockLoadUserTimezone.mockResolvedValue(null);
    mockRefreshSession.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(mockRefreshSession).toHaveBeenCalledTimes(1));
    let finish!: (_value: { token: string; user_id: number; timezone: string }) => void;
    mockRefreshSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      foreground('background');
    });
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      foreground('active');
    });
    expect(mockRefreshSession).toHaveBeenCalledTimes(2);
    await act(async () => {
      await result.current.logout();
    });
    await act(async () => {
      finish({ token: 'stale-jwt', user_id: 7, timezone: 'America/Los_Angeles' });
    });
    expect(result.current.token).toBeNull();
    expect(result.current.authStatus).toBe('anonymous');
    expect(result.current.userTimezoneReady).toBe(false);
    listener.mockRestore();
  });
});
