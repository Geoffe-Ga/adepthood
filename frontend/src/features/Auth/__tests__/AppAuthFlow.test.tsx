/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { render } from '@testing-library/react-native';
import React from 'react';

type AuthStatus = 'loading' | 'authenticated' | 'reauth-required' | 'anonymous';

// Control mock state per test. ``token`` + ``isLoading`` are kept so
// legacy callers that still read them keep working; the navigator
// itself now gates on ``authStatus`` (BUG-NAV-001 / BUG-NAV-002).
let mockAuthState: { token: string | null; authStatus: AuthStatus; isLoading: boolean } = {
  token: null,
  authStatus: 'anonymous',
  isLoading: false,
};

jest.mock('@/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    ...mockAuthState,
    login: jest.fn(),
    signup: jest.fn(),
    logout: jest.fn(),
    onUnauthorized: jest.fn(),
    dismissReauth: jest.fn(),
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock navigators to simple pass-through components
jest.mock('@react-navigation/native', () => ({
  NavigationContainer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({
    Navigator: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Screen: ({ component: Component }: { component: React.ComponentType<unknown> }) => (
      <Component />
    ),
  }),
}));

// Mock child screens to simple identifiable components
jest.mock('@/features/Auth/LoginScreen', () => {
  const { Text } = require('react-native');
  return () => <Text>LoginScreen</Text>;
});
jest.mock('@/features/Auth/SignupScreen', () => {
  const { Text } = require('react-native');
  return () => <Text>SignupScreen</Text>;
});
jest.mock('@/features/Auth/ReauthSheet', () => {
  const { Text } = require('react-native');
  return { ReauthSheet: () => <Text>ReauthSheet</Text> };
});
jest.mock('@/navigation/BottomTabs', () => {
  const { Text } = require('react-native');
  return () => <Text>BottomTabs</Text>;
});

import App from '@/App';

beforeEach(() => {
  mockAuthState = { token: null, authStatus: 'anonymous', isLoading: false };
});

describe('App auth flow', () => {
  it('shows auth screens when user is anonymous', () => {
    mockAuthState = { token: null, authStatus: 'anonymous', isLoading: false };
    const { getByText } = render(<App />);

    expect(getByText('LoginScreen')).toBeTruthy();
  });

  it('shows loading indicator while authStatus is loading', () => {
    mockAuthState = { token: null, authStatus: 'loading', isLoading: true };
    const { getByTestId } = render(<App />);

    expect(getByTestId('auth-loading')).toBeTruthy();
  });

  it('shows main app when user is authenticated', () => {
    mockAuthState = { token: 'valid-jwt', authStatus: 'authenticated', isLoading: false };
    const { getByText } = render(<App />);

    expect(getByText('BottomTabs')).toBeTruthy();
  });

  it('does not show auth screens when authenticated', () => {
    mockAuthState = { token: 'valid-jwt', authStatus: 'authenticated', isLoading: false };
    const { queryByText } = render(<App />);

    expect(queryByText('LoginScreen')).toBeNull();
  });

  it('does not show main app when anonymous', () => {
    mockAuthState = { token: null, authStatus: 'anonymous', isLoading: false };
    const { queryByText } = render(<App />);

    expect(queryByText('BottomTabs')).toBeNull();
  });

  // BUG-NAV-001: a 401 must not unmount the tabs. When authStatus is
  // 'reauth-required' we show BottomTabs *and* the ReauthSheet overlay.
  it('keeps BottomTabs mounted and shows ReauthSheet when reauth-required', () => {
    mockAuthState = { token: null, authStatus: 'reauth-required', isLoading: false };
    const { getByText } = render(<App />);

    expect(getByText('BottomTabs')).toBeTruthy();
    expect(getByText('ReauthSheet')).toBeTruthy();
  });
});
