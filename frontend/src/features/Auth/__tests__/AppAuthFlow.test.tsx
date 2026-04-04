/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { render } from '@testing-library/react-native';
import React from 'react';

// Control mock state per test
let mockAuthState = { token: null as string | null, isLoading: false };

jest.mock('@/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    ...mockAuthState,
    login: jest.fn(),
    signup: jest.fn(),
    logout: jest.fn(),
    onUnauthorized: jest.fn(),
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
jest.mock('@/navigation/BottomTabs', () => {
  const { Text } = require('react-native');
  return () => <Text>BottomTabs</Text>;
});

import App from '@/App';

beforeEach(() => {
  mockAuthState = { token: null, isLoading: false };
});

describe('App auth flow', () => {
  it('shows auth screens when user is not authenticated', () => {
    mockAuthState = { token: null, isLoading: false };
    const { getByText } = render(<App />);

    expect(getByText('LoginScreen')).toBeTruthy();
  });

  it('shows loading indicator while checking auth', () => {
    mockAuthState = { token: null, isLoading: true };
    const { getByTestId } = render(<App />);

    expect(getByTestId('auth-loading')).toBeTruthy();
  });

  it('shows main app when user is authenticated', () => {
    mockAuthState = { token: 'valid-jwt', isLoading: false };
    const { getByText } = render(<App />);

    expect(getByText('BottomTabs')).toBeTruthy();
  });

  it('does not show auth screens when authenticated', () => {
    mockAuthState = { token: 'valid-jwt', isLoading: false };
    const { queryByText } = render(<App />);

    expect(queryByText('LoginScreen')).toBeNull();
  });

  it('does not show main app when not authenticated', () => {
    mockAuthState = { token: null, isLoading: false };
    const { queryByText } = render(<App />);

    expect(queryByText('BottomTabs')).toBeNull();
  });
});
