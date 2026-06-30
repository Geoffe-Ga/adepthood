/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
/**
 * Issue #836: the program welcome gates the authenticated shell on first run.
 * Once the persisted ``hasSeenWelcome`` flag has resolved to unset, the
 * WelcomeScreen overlays the shell; for returning users (flag set) the shell
 * renders straight away. These tests drive ``RootNavigator`` directly, mocking
 * the navigation tree exactly as ``authStatusNavigator.test.tsx`` does.
 */
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  const { mockDefaultTheme, mockDarkTheme } = require('@/test-utils/navMocks');
  return {
    __esModule: true,
    NavigationContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useNavigation: () => ({ navigate: jest.fn(), getParent: () => undefined }),
    useRoute: () => ({ params: undefined }),
    useFocusEffect: (fn: () => void) => fn(),
    DefaultTheme: mockDefaultTheme,
    DarkTheme: mockDarkTheme,
  };
});

jest.mock('@/navigation/RootStack', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const RootStackMock = () => React.createElement(Text, { testID: 'root-stack' }, 'RootStack');
  return { __esModule: true, default: RootStackMock };
});

jest.mock('@/features/Welcome/WelcomeScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const WelcomeMock = () => React.createElement(Text, { testID: 'welcome-screen' }, 'Welcome');
  return { __esModule: true, WelcomeScreen: WelcomeMock, default: WelcomeMock };
});

jest.mock('@/features/Auth/LoginScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const LoginMock = () => React.createElement(Text, { testID: 'login-screen' }, 'Login');
  return { __esModule: true, default: LoginMock };
});

jest.mock('@react-navigation/native-stack', () => {
  const React = require('react');
  return {
    __esModule: true,
    createNativeStackNavigator: () => ({
      Navigator: ({ children }: { children: React.ReactNode }) => {
        const first = React.Children.toArray(children)[0] as React.ReactElement<{
          component: React.ComponentType;
        }>;
        if (!first) return null;
        const Component = first.props.component;
        return React.createElement(Component);
      },
      Screen: () => null,
    }),
  };
});

jest.mock('@/components/FeatureErrorBoundary', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Boundary = ({ children }: { children: React.ReactNode }) =>
    React.createElement(View, null, children);
  return { __esModule: true, FeatureErrorBoundary: Boundary };
});

jest.mock('@/storage/welcomeStorage', () => ({
  __esModule: true,
  // A never-settling load keeps ``hasSeenWelcome`` ``null`` so the no-flash
  // test can assert the pre-hydration paint without a stray act() update.
  loadHasSeenWelcome: jest.fn(() => new Promise(() => undefined)),
  saveHasSeenWelcome: jest.fn(() => Promise.resolve()),
  clearHasSeenWelcome: jest.fn(() => Promise.resolve()),
}));

import { render, act } from '@testing-library/react-native';
import React from 'react';

import { RootNavigator } from '@/App';
import * as AuthContextModule from '@/context/AuthContext';
import type { AuthStatus } from '@/context/AuthContext';
import { useWelcomeStore } from '@/store/useWelcomeStore';

function mockAuthenticated() {
  jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    token: 'jwt',
    authStatus: 'authenticated' as AuthStatus,
    isLoading: false,
    userTimezone: 'UTC',
    setUserTimezone: jest.fn(),
    login: jest.fn(() => Promise.resolve()),
    signup: jest.fn(() => Promise.resolve()),
    logout: jest.fn(() => Promise.resolve()),
    onUnauthorized: jest.fn(),
    dismissReauth: jest.fn(() => Promise.resolve()),
    confirmPasswordReset: jest.fn(() => Promise.resolve()),
  } as unknown as ReturnType<typeof AuthContextModule.useAuth>);
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockAuthenticated();
});

describe('WelcomeGate (issue #836)', () => {
  it('shows the WelcomeScreen on first run (flag resolved to unset)', () => {
    act(() => useWelcomeStore.setState({ hasSeenWelcome: false }));
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    expect(getByTestId('welcome-screen')).toBeTruthy();
    expect(queryByTestId('root-stack')).toBeNull();
  });

  it('goes straight to the shell for a returning user (flag set)', () => {
    act(() => useWelcomeStore.setState({ hasSeenWelcome: true }));
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    expect(getByTestId('root-stack')).toBeTruthy();
    expect(queryByTestId('welcome-screen')).toBeNull();
  });

  it('does not flash the welcome before the flag has hydrated', () => {
    act(() => useWelcomeStore.setState({ hasSeenWelcome: null }));
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    expect(getByTestId('root-stack')).toBeTruthy();
    expect(queryByTestId('welcome-screen')).toBeNull();
  });
});
