/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
/**
 * BUG-NAV-001 / BUG-NAV-002: the root navigator used to gate on the raw
 * ``token`` field, so any transient 401 that nulled the token also
 * unmounted BottomTabs and landed the user on Signup. With the explicit
 * ``authStatus`` state machine, a 401 transitions to ``'reauth-required'``
 * — RootStack stays mounted and the re-auth sheet appears as an overlay.
 *
 * These tests exercise the navigator gate directly rather than going
 * through the full React Navigation tree so they stay focused on the
 * state-machine → navigator contract.
 */
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    __esModule: true,
    NavigationContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useNavigation: () => ({ navigate: jest.fn(), getParent: () => undefined }),
    useRoute: () => ({ params: undefined }),
    useFocusEffect: (fn: () => void) => fn(),
  };
});

jest.mock('@/navigation/RootStack', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const RootStackMock = () => React.createElement(Text, { testID: 'root-stack' }, 'RootStack');
  return { __esModule: true, default: RootStackMock };
});

jest.mock('@/features/Auth/LoginScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const LoginMock = () => React.createElement(Text, { testID: 'login-screen' }, 'Login');
  return { __esModule: true, default: LoginMock };
});

jest.mock('@/features/Auth/SignupScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const SignupMock = () => React.createElement(Text, { testID: 'signup-screen' }, 'Signup');
  return { __esModule: true, default: SignupMock };
});

jest.mock('@react-navigation/native-stack', () => {
  const React = require('react');
  return {
    __esModule: true,
    createNativeStackNavigator: () => ({
      // A bare-bones stand-in: ``Navigator`` renders the first child's
      // component, which is enough for the "is AuthNavigator mounted?" test.
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

import { render } from '@testing-library/react-native';
import React from 'react';

import { RootNavigator } from '@/App';
import * as AuthContextModule from '@/context/AuthContext';
import type { AuthStatus } from '@/context/AuthContext';

type MockAuth = {
  token: string | null;
  authStatus: AuthStatus;
  isLoading: boolean;
  login: jest.Mock;
  signup: jest.Mock;
  logout: jest.Mock;
  onUnauthorized: jest.Mock;
  dismissReauth: jest.Mock;
};

function buildAuth(overrides: Partial<MockAuth> = {}): MockAuth {
  return {
    token: null,
    authStatus: 'anonymous',
    isLoading: false,
    login: jest.fn(() => Promise.resolve()),
    signup: jest.fn(() => Promise.resolve()),
    logout: jest.fn(() => Promise.resolve()),
    onUnauthorized: jest.fn(),
    dismissReauth: jest.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function mockAuthStatus(status: AuthStatus, token: string | null = null) {
  jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue(
    buildAuth({
      authStatus: status,
      token,
      isLoading: status === 'loading',
    }),
  );
}

beforeEach(() => {
  jest.restoreAllMocks();
});

describe('RootNavigator gated on authStatus (BUG-NAV-001 / BUG-NAV-002)', () => {
  it("mounts the BootSplash only while authStatus is 'loading'", () => {
    mockAuthStatus('loading');
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    expect(getByTestId('auth-loading')).toBeTruthy();
    expect(queryByTestId('root-stack')).toBeNull();
  });

  it("mounts the AuthNavigator when authStatus is 'anonymous'", () => {
    mockAuthStatus('anonymous');
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    expect(getByTestId('login-screen')).toBeTruthy();
    expect(queryByTestId('root-stack')).toBeNull();
    expect(queryByTestId('reauth-sheet')).toBeNull();
  });

  it("mounts RootStack (no overlay) when authStatus is 'authenticated'", () => {
    mockAuthStatus('authenticated', 'jwt');
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    expect(getByTestId('root-stack')).toBeTruthy();
    expect(queryByTestId('reauth-sheet')).toBeNull();
    expect(queryByTestId('login-screen')).toBeNull();
  });

  it("mounts RootStack *and* the re-auth sheet when authStatus is 'reauth-required'", () => {
    mockAuthStatus('reauth-required');
    const { getByTestId } = render(<RootNavigator />);
    // Critical: RootStack stays mounted — do NOT boot the user to Signup.
    expect(getByTestId('root-stack')).toBeTruthy();
    // Overlay surfaces the re-auth prompt without tearing down tabs.
    expect(getByTestId('reauth-sheet')).toBeTruthy();
  });

  it('keeps RootStack mounted across an authenticated → reauth-required transition', () => {
    mockAuthStatus('authenticated', 'jwt');
    const { getByTestId, rerender } = render(<RootNavigator />);
    expect(getByTestId('root-stack')).toBeTruthy();

    mockAuthStatus('reauth-required');
    rerender(<RootNavigator />);
    // RootStack must still be there — we never unmount it for a 401.
    expect(getByTestId('root-stack')).toBeTruthy();
    expect(getByTestId('reauth-sheet')).toBeTruthy();
  });
});
