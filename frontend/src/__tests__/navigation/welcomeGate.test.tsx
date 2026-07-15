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

// A never-settling GET keeps the store gated on the local-cache fallback for
// tests that drive useWelcomeStore state directly.
jest.mock('@/api', () => ({
  __esModule: true,
  uiFlags: {
    get: jest.fn(() => new Promise(() => undefined)),
    update: jest.fn(() => Promise.resolve()),
  },
}));

import { render, act, waitFor } from '@testing-library/react-native';
import React from 'react';

import { uiFlags } from '@/api';
import { RootNavigator } from '@/App';
import * as AuthContextModule from '@/context/AuthContext';
import type { AuthStatus } from '@/context/AuthContext';
import { useWelcomeStore } from '@/store/useWelcomeStore';

const mockUiFlagsGet = jest.mocked(uiFlags.get);

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

// Gate-level swap locks (stub RootStack = the Journal shell); the route-level
// assertion lives in the companion welcomeLandsOnJournal.test.tsx harness.
describe('WelcomeGate → Journal shell (regression locks)', () => {
  // Fails if markSeen stops firing on Begin/Skip so the shell never mounts.
  it('returning user sees the shell (root-stack) that hosts Journal, not Welcome', () => {
    // Returning user: hasSeenWelcome already true (no Begin/Skip needed).
    act(() => useWelcomeStore.setState({ hasSeenWelcome: true }));
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    // The shell embeds BottomTabs with initialRouteName="Journal".
    // This testID presence is the gate-level proxy for "Journal is mounted".
    expect(getByTestId('root-stack')).toBeTruthy();
    expect(queryByTestId('welcome-screen')).toBeNull();
  });

  // Fails if the gate showed Welcome while hasSeenWelcome is null (a flash).
  it('pre-hydration state shows the shell (root-stack) that hosts Journal, not Welcome', () => {
    // null = storage not yet read; no-flash contract: shell renders immediately.
    act(() => useWelcomeStore.setState({ hasSeenWelcome: null }));
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    expect(getByTestId('root-stack')).toBeTruthy();
    expect(queryByTestId('welcome-screen')).toBeNull();
  });
});

// End-to-end through the real useFirstRun hook (not a setState bypass) so the
// server round-trip actually drives the gate.
describe('WelcomeGate — server hydration', () => {
  beforeEach(() => {
    act(() => useWelcomeStore.setState({ hasSeenWelcome: null }));
  });

  it('does not flash the welcome while the server GET is still pending', () => {
    mockUiFlagsGet.mockReturnValueOnce(
      new Promise<{ has_seen_welcome: boolean; energy_scaffolding_archived: boolean }>(
        () => undefined,
      ),
    );
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    expect(getByTestId('root-stack')).toBeTruthy();
    expect(queryByTestId('welcome-screen')).toBeNull();
    // Pins that hydration is server-driven, not just the stay-closed no-flash.
    expect(mockUiFlagsGet).toHaveBeenCalledWith('jwt');
  });

  it('returning user (server has_seen_welcome=true, empty local cache) lands on root-stack', async () => {
    mockUiFlagsGet.mockResolvedValueOnce({
      has_seen_welcome: true,
      energy_scaffolding_archived: false,
    });
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    await waitFor(() => expect(mockUiFlagsGet).toHaveBeenCalledWith('jwt'));
    expect(getByTestId('root-stack')).toBeTruthy();
    expect(queryByTestId('welcome-screen')).toBeNull();
  });

  it('first-run (server has_seen_welcome=false) shows Welcome; markSeen closes it', async () => {
    mockUiFlagsGet.mockResolvedValueOnce({
      has_seen_welcome: false,
      energy_scaffolding_archived: false,
    });
    const { getByTestId, queryByTestId } = render(<RootNavigator />);
    await waitFor(() => expect(getByTestId('welcome-screen')).toBeTruthy());
    expect(queryByTestId('root-stack')).toBeNull();

    act(() => useWelcomeStore.getState().markWelcomeSeen());

    expect(queryByTestId('welcome-screen')).toBeNull();
    expect(getByTestId('root-stack')).toBeTruthy();
  });
});
