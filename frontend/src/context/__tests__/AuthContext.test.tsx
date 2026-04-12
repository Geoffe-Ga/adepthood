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

import { auth, setTokenGetter } from '@/api';
import { saveToken, loadToken, clearToken } from '@/storage/authStorage';
import { isTokenExpired, shouldRefreshToken } from '@/utils/token';

const mockAuth = auth as jest.Mocked<typeof auth>;
const mockLoadToken = loadToken as jest.MockedFunction<typeof loadToken>;
const mockSaveToken = saveToken as jest.MockedFunction<typeof saveToken>;
const mockClearToken = clearToken as jest.MockedFunction<typeof clearToken>;
const mockSetTokenGetter = setTokenGetter as jest.MockedFunction<typeof setTokenGetter>;
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
  });
});
