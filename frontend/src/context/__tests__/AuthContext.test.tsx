/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import React from 'react';

import { AuthProvider, useAuth } from '../AuthContext';

// Mock the API client
jest.mock('@/api', () => ({
  auth: {
    login: jest.fn(),
    signup: jest.fn(),
  },
  setTokenGetter: jest.fn(),
  setOnUnauthorized: jest.fn(),
}));

// Mock authStorage
jest.mock('@/storage/authStorage', () => ({
  saveToken: jest.fn(() => Promise.resolve()),
  loadToken: jest.fn(() => Promise.resolve(null)),
  clearToken: jest.fn(() => Promise.resolve()),
}));

import { auth, setTokenGetter } from '@/api';
import { saveToken, loadToken, clearToken } from '@/storage/authStorage';

const mockAuth = auth as jest.Mocked<typeof auth>;
const mockLoadToken = loadToken as jest.MockedFunction<typeof loadToken>;
const mockSaveToken = saveToken as jest.MockedFunction<typeof saveToken>;
const mockClearToken = clearToken as jest.MockedFunction<typeof clearToken>;
const mockSetTokenGetter = setTokenGetter as jest.MockedFunction<typeof setTokenGetter>;

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadToken.mockResolvedValue(null);
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
        username: 'user@test.com',
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
        username: 'new@test.com',
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
});
