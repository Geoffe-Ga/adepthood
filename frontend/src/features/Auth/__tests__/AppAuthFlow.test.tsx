/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { render } from '@testing-library/react-native';
import React from 'react';

type AuthStatus = 'loading' | 'authenticated' | 'reauth-required' | 'anonymous';

// Control mock state per test. The navigator gates on ``authStatus``
// (BUG-NAV-001 / BUG-NAV-002); ``token`` is kept for the routes that read it.
let mockAuthState: { token: string | null; authStatus: AuthStatus } = {
  token: null,
  authStatus: 'anonymous',
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
  // ToastProvider (rendered inside App) reads the top inset.
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Mock navigators to simple pass-through components.  ``useNavigation``
// is required because ``FeatureErrorBoundary`` calls it for the
// route-focus auto-reset (BUG-FE-UI-102); returning a stub navigation
// object that no-ops on ``addListener`` keeps the unrelated auth-flow
// assertions free of routing side effects.
jest.mock('@react-navigation/native', () => {
  // navTheme (via App.tsx) extends DefaultTheme, so the mock must expose it.
  const { mockDefaultTheme, mockDarkTheme } = require('@/test-utils/navMocks');
  return {
    NavigationContainer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useNavigation: () => ({
      addListener: () => () => {
        /* unused in this test */
      },
    }),
    DefaultTheme: mockDefaultTheme,
    DarkTheme: mockDarkTheme,
  };
});

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
// New for issue #348: RootStack mounts SharePreviewScreen as a sibling
// route to ``Tabs``. The mocked navigator renders every child component
// with no props, and the real screen reads ``route.params.token`` --
// stub it out so the auth-flow tests stay focused on auth gating.
jest.mock('@/features/Practice/screens/SharePreviewScreen', () => {
  const { Text } = require('react-native');
  return () => <Text>SharePreviewScreen</Text>;
});
// custom-practices-07: RootStack mounts the practice detail screen and
// the create-practice wizard as siblings to ``Tabs``. Both read
// ``route.params``, which the navigator stub above does not provide --
// stub them out so this suite stays focused on auth gating.
jest.mock('@/features/Practice/screens/PracticeDetailScreen', () => {
  const { Text } = require('react-native');
  const Stub = () => <Text>PracticeDetailScreen</Text>;
  return { PracticeDetailScreen: Stub, default: Stub };
});
jest.mock('@/features/Practice/screens/CreatePracticeWizard', () => {
  const { Text } = require('react-native');
  const Stub = () => <Text>CreatePracticeWizard</Text>;
  return { CreatePracticeWizard: Stub, default: Stub };
});
// practice-redesign-01: RootStack now mounts the catalog as a pushed sibling
// route. It reads ``route.params`` (useRoute), which the navigator stub does
// not provide -- stub it out so this suite stays focused on auth gating.
jest.mock('@/features/Practice/screens/PracticeCatalogScreen', () => {
  const { Text } = require('react-native');
  const Stub = () => <Text>PracticeCatalogScreen</Text>;
  return { PracticeCatalogScreen: Stub, default: Stub };
});
// journal-resonance-11: RootStack now mounts JournalEntryScreen as a pushed
// route that reads ``route.params`` -- stub it for the same reason as above.
jest.mock('@/features/Journal/JournalEntryScreen', () => {
  const { Text } = require('react-native');
  const Stub = () => <Text>JournalEntryScreen</Text>;
  return { __esModule: true, default: Stub };
});
// RootStack now mounts JournalPhotographScreen as a pushed sibling route; it
// runs a photo-pick on mount and reads ``navigation`` -- stub it for the same
// reason as the routes above so this suite stays focused on auth gating.
jest.mock('@/features/Journal/JournalPhotographScreen', () => {
  const { Text } = require('react-native');
  const Stub = () => <Text>JournalPhotographScreen</Text>;
  return { __esModule: true, default: Stub };
});

import App, { linking } from '@/App';
import { useWelcomeStore } from '@/store/useWelcomeStore';

beforeEach(() => {
  mockAuthState = { token: null, authStatus: 'anonymous' };
  // This suite asserts the auth-status → shell contract; the #836 first-run
  // welcome gate is exercised separately. Seed the flag as seen so an authed
  // render reaches the shell rather than the WelcomeScreen.
  useWelcomeStore.setState({ hasSeenWelcome: true });
});

describe('App auth flow', () => {
  it('shows auth screens when user is anonymous', () => {
    mockAuthState = { token: null, authStatus: 'anonymous' };
    const { getByText } = render(<App />);

    expect(getByText('LoginScreen')).toBeTruthy();
  });

  it('shows loading indicator while authStatus is loading', () => {
    mockAuthState = { token: null, authStatus: 'loading' };
    const { getByTestId } = render(<App />);

    expect(getByTestId('auth-loading')).toBeTruthy();
  });

  it('shows main app when user is authenticated', () => {
    mockAuthState = { token: 'valid-jwt', authStatus: 'authenticated' };
    const { getByText } = render(<App />);

    expect(getByText('BottomTabs')).toBeTruthy();
  });

  it('does not show auth screens when authenticated', () => {
    mockAuthState = { token: 'valid-jwt', authStatus: 'authenticated' };
    const { queryByText } = render(<App />);

    expect(queryByText('LoginScreen')).toBeNull();
  });

  it('does not show main app when anonymous', () => {
    mockAuthState = { token: null, authStatus: 'anonymous' };
    const { queryByText } = render(<App />);

    expect(queryByText('BottomTabs')).toBeNull();
  });

  // BUG-NAV-001: a 401 must not unmount the tabs. When authStatus is
  // 'reauth-required' we show BottomTabs *and* the ReauthSheet overlay.
  it('keeps BottomTabs mounted and shows ReauthSheet when reauth-required', () => {
    mockAuthState = { token: null, authStatus: 'reauth-required' };
    const { getByText } = render(<App />);

    expect(getByText('BottomTabs')).toBeTruthy();
    expect(getByText('ReauthSheet')).toBeTruthy();
  });
});

describe('deep linking config', () => {
  it('keeps the adepthood://api-key-settings deep link pointed at the API key screen', () => {
    const screens = linking.config?.screens as Record<string, unknown> | undefined;

    expect(linking.prefixes).toContain('adepthood://');
    expect(screens?.ApiKeySettings).toBe('api-key-settings');
  });

  it('resolves the Settings hub deep link', () => {
    const screens = linking.config?.screens as Record<string, unknown> | undefined;

    expect(screens?.Settings).toBe('settings');
  });
});
