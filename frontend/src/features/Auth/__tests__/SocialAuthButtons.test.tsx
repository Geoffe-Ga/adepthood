/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { render, fireEvent } from '@testing-library/react-native';
import { AppleAuthenticationButtonStyle } from 'expo-apple-authentication';
import React from 'react';

jest.mock('../useGoogleAuth', () => ({ useGoogleAuth: jest.fn() }));
jest.mock('../useAppleAuth', () => ({
  useAppleAuth: jest.fn(),
  useAppleSignInAvailable: jest.fn(),
}));
jest.mock('../oauthConfig', () => ({
  isGoogleAuthConfigured: jest.fn(),
  googleClientIds: { ios: '', android: '', web: '' },
}));
jest.mock('@/config', () => ({
  API_BASE_URL: 'http://test',
  CONFIG_ERROR: null,
  GUMROAD_PRODUCT_URL: 'https://gumroad.test/l/adepthood',
  GUMROAD_HELP_URL: 'https://gumroad.test/help/license-keys',
}));
jest.mock('@/utils/openExternalUrl', () => ({
  openExternalUrl: jest.fn(() => Promise.resolve(true)),
}));

import { isGoogleAuthConfigured } from '../oauthConfig';
import { SocialAuthButtons } from '../SocialAuthButtons';
import { useAppleAuth, useAppleSignInAvailable } from '../useAppleAuth';
import { useGoogleAuth } from '../useGoogleAuth';

import { ThemeProvider, type ThemeMode } from '@/design/ThemeContext';

const mockIsConfigured = isGoogleAuthConfigured as jest.MockedFunction<
  typeof isGoogleAuthConfigured
>;
const mockUseGoogleAuth = useGoogleAuth as unknown as jest.Mock;
const mockUseAppleAuth = useAppleAuth as unknown as jest.Mock;
const mockUseAppleAvailable = useAppleSignInAvailable as unknown as jest.Mock;

const GOOGLE_LABEL = 'Continue with Google';
const LICENSE_LABEL = 'Gumroad license key';
const LICENSE_SUBMIT_ID = 'social-auth-license-submit';
const GOOGLE_BUTTON_ID = 'social-auth-google';
const APPLE_BUTTON_ID = 'social-auth-apple';
const APPLE_ERROR_ID = 'social-auth-apple-error';
const APPLE_LICENSE_SUBMIT_ID = 'social-auth-apple-license-submit';
const VALID_LICENSE_KEY = 'A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6'; // pragma: allowlist secret
const TOO_SHORT_KEY = 'abc'; // pragma: allowlist secret
const TOO_SHORT_COPY = 'That key looks too short — a Gumroad key is at least 8 characters.';
const KEY_REQUIRED_COPY = 'Add the license key from your Gumroad receipt to continue.';
const REFUSAL_COPY = 'A license key is needed to finish connecting this sign-in.';

const signIn = jest.fn();
const submitLicenseKey = jest.fn();
const appleSignIn = jest.fn();
const appleSubmitLicenseKey = jest.fn();

interface SocialAuthState {
  status: 'idle' | 'needsLicense';
  error: string | null;
  submitting: boolean;
}

function hookState(state: Partial<SocialAuthState>, onSignIn: jest.Mock, onSubmitKey: jest.Mock) {
  return {
    status: state.status ?? 'idle',
    error: state.error ?? null,
    submitting: state.submitting ?? false,
    signIn: onSignIn,
    submitLicenseKey: onSubmitKey,
  };
}

function setGoogleAuth(state: Partial<SocialAuthState> = {}): void {
  mockUseGoogleAuth.mockReturnValue(hookState(state, signIn, submitLicenseKey));
}

function setAppleAuth(state: Partial<SocialAuthState> = {}): void {
  mockUseAppleAuth.mockReturnValue(hookState(state, appleSignIn, appleSubmitLicenseKey));
}

interface RenderedNode {
  props?: Record<string, unknown>;
  children?: unknown[] | null;
}

/**
 * Every testID in render order. Comparing these sequences pins layout: a
 * hidden placeholder for an absent provider would show up as an extra slot.
 */
function testIdsOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap((child) => testIdsOf(child));
  if (node === null || typeof node !== 'object') return [];
  const { props, children } = node as RenderedNode;
  const testId = props === undefined ? undefined : props.testID;
  const own = typeof testId === 'string' ? [testId] : [];
  return [...own, ...testIdsOf(children ?? [])];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsConfigured.mockReturnValue(true);
  mockUseAppleAvailable.mockReturnValue(false);
  setGoogleAuth();
  setAppleAuth();
});

describe('SocialAuthButtons — configuration gate', () => {
  it('renders nothing when no Google client ID is configured', () => {
    mockIsConfigured.mockReturnValue(false);

    const { queryByLabelText, queryByText, toJSON } = render(<SocialAuthButtons />);

    expect(queryByLabelText(GOOGLE_LABEL)).toBeNull();
    expect(queryByText('or')).toBeNull();
    expect(toJSON()).toBeNull();
  });

  // Rules of hooks: the auth hook lives in an inner component that is only
  // mounted once the config check passes, so an unconfigured build must never
  // reach ``Google.useAuthRequest`` at all.
  it('does not run the Google auth hook when unconfigured', () => {
    mockIsConfigured.mockReturnValue(false);

    render(<SocialAuthButtons />);

    expect(mockUseGoogleAuth).not.toHaveBeenCalled();
  });

  it('renders the button and the quiet divider when configured', () => {
    const { getByLabelText, getByText } = render(<SocialAuthButtons />);

    expect(getByLabelText(GOOGLE_LABEL)).toBeTruthy();
    expect(getByText('or')).toBeTruthy();
  });

  it('starts the Google flow when the button is pressed', () => {
    const { getByLabelText } = render(<SocialAuthButtons />);

    fireEvent.press(getByLabelText(GOOGLE_LABEL));

    expect(signIn).toHaveBeenCalledTimes(1);
  });
});

describe('SocialAuthButtons — inline license step', () => {
  it('shows the license field in place rather than a second Google prompt', () => {
    setGoogleAuth({ status: 'needsLicense' });

    const { getByLabelText } = render(<SocialAuthButtons />);

    expect(getByLabelText(LICENSE_LABEL)).toBeTruthy();
    expect(getByLabelText(GOOGLE_LABEL)).toBeTruthy();
    expect(signIn).not.toHaveBeenCalled();
  });

  it('hides the license field while idle', () => {
    const { queryByLabelText } = render(<SocialAuthButtons />);

    expect(queryByLabelText(LICENSE_LABEL)).toBeNull();
  });

  it('announces the refusal copy to screen readers', () => {
    setGoogleAuth({ status: 'needsLicense', error: REFUSAL_COPY });

    const { getByRole } = render(<SocialAuthButtons />);
    const alert = getByRole('alert');

    expect(alert).toHaveTextContent(REFUSAL_COPY);
    expect(alert.props.accessibilityLiveRegion).toBe('polite');
  });

  it('submits a well-formed key to the hook verbatim', () => {
    setGoogleAuth({ status: 'needsLicense' });
    const { getByLabelText, getByTestId } = render(<SocialAuthButtons />);

    fireEvent.changeText(getByLabelText(LICENSE_LABEL), VALID_LICENSE_KEY);
    fireEvent.press(getByTestId(LICENSE_SUBMIT_ID));

    expect(submitLicenseKey).toHaveBeenCalledWith(VALID_LICENSE_KEY);
  });
});

describe('SocialAuthButtons — client-side license validation', () => {
  it('does not call the hook when the key is too short', () => {
    setGoogleAuth({ status: 'needsLicense' });
    const { getByLabelText, getByTestId, getByRole } = render(<SocialAuthButtons />);

    fireEvent.changeText(getByLabelText(LICENSE_LABEL), TOO_SHORT_KEY);
    fireEvent.press(getByTestId(LICENSE_SUBMIT_ID));

    expect(submitLicenseKey).not.toHaveBeenCalled();
    expect(getByRole('alert')).toHaveTextContent(TOO_SHORT_COPY);
  });

  it('does not call the hook when the field is empty', () => {
    setGoogleAuth({ status: 'needsLicense' });
    const { getByTestId, getByRole } = render(<SocialAuthButtons />);

    fireEvent.press(getByTestId(LICENSE_SUBMIT_ID));

    expect(submitLicenseKey).not.toHaveBeenCalled();
    expect(getByRole('alert')).toHaveTextContent(KEY_REQUIRED_COPY);
  });

  it('carries the alert role and live region on the validation error too', () => {
    setGoogleAuth({ status: 'needsLicense' });
    const { getByTestId, getByRole } = render(<SocialAuthButtons />);

    fireEvent.press(getByTestId(LICENSE_SUBMIT_ID));

    expect(getByRole('alert').props.accessibilityLiveRegion).toBe('polite');
  });
});

describe('SocialAuthButtons — busy state', () => {
  it('disables the Google button while an exchange is in flight', () => {
    setGoogleAuth({ submitting: true });

    const { getByLabelText } = render(<SocialAuthButtons />);
    fireEvent.press(getByLabelText(GOOGLE_LABEL));

    expect(signIn).not.toHaveBeenCalled();
  });

  it('disables the license submit while an exchange is in flight', () => {
    setGoogleAuth({ status: 'needsLicense', submitting: true });

    const { getByLabelText, getByTestId } = render(<SocialAuthButtons />);
    fireEvent.changeText(getByLabelText(LICENSE_LABEL), VALID_LICENSE_KEY);
    fireEvent.press(getByTestId(LICENSE_SUBMIT_ID));

    expect(submitLicenseKey).not.toHaveBeenCalled();
  });
});

describe('SocialAuthButtons — Apple availability gate', () => {
  // A device that cannot offer Apple sign-in must see the exact tree it saw
  // before Apple existed — no reserved gap, no disabled control.
  it('leaves no Apple slot and no placeholder when Apple sign-in is unavailable', () => {
    mockUseAppleAvailable.mockReturnValue(true);
    const withApple = testIdsOf(render(<SocialAuthButtons />).toJSON());
    mockUseAppleAvailable.mockReturnValue(false);

    const { queryByTestId, toJSON } = render(<SocialAuthButtons />);

    expect(queryByTestId(APPLE_BUTTON_ID)).toBeNull();
    expect(testIdsOf(toJSON())).toEqual(withApple.filter((id) => !id.startsWith(APPLE_BUTTON_ID)));
  });

  it('renders the Apple button below the Google button when available', () => {
    mockUseAppleAvailable.mockReturnValue(true);

    const { getByTestId, toJSON } = render(<SocialAuthButtons />);
    const ids = testIdsOf(toJSON());

    expect(getByTestId(APPLE_BUTTON_ID)).toBeTruthy();
    expect(ids.indexOf(APPLE_BUTTON_ID)).toBeGreaterThan(ids.indexOf(GOOGLE_BUTTON_ID));
  });

  // Rules of hooks again, from the other side: an unconfigured Google build
  // still has an Apple row to draw, and drawing it must not reach the Google
  // provider.
  it('still renders the row when Google is unconfigured but Apple is available', () => {
    mockIsConfigured.mockReturnValue(false);
    mockUseAppleAvailable.mockReturnValue(true);

    const { getByTestId, getByText, queryByLabelText } = render(<SocialAuthButtons />);

    expect(getByTestId(APPLE_BUTTON_ID)).toBeTruthy();
    expect(getByText('or')).toBeTruthy();
    expect(queryByLabelText(GOOGLE_LABEL)).toBeNull();
    expect(mockUseGoogleAuth).not.toHaveBeenCalled();
  });

  it('renders nothing when Google is unconfigured and Apple is unavailable', () => {
    mockIsConfigured.mockReturnValue(false);
    mockUseAppleAvailable.mockReturnValue(false);

    const { queryByTestId, toJSON } = render(<SocialAuthButtons />);

    expect(toJSON()).toBeNull();
    expect(queryByTestId(APPLE_BUTTON_ID)).toBeNull();
  });
});

describe('SocialAuthButtons — Apple flow', () => {
  it('starts the Apple flow, and only the Apple flow, when its button is pressed', () => {
    mockUseAppleAvailable.mockReturnValue(true);
    const { getByTestId } = render(<SocialAuthButtons />);

    fireEvent.press(getByTestId(APPLE_BUTTON_ID));

    expect(appleSignIn).toHaveBeenCalledTimes(1);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('ignores an Apple press while the Apple exchange is in flight', () => {
    mockUseAppleAvailable.mockReturnValue(true);
    setAppleAuth({ submitting: true });
    const { getByTestId } = render(<SocialAuthButtons />);

    fireEvent.press(getByTestId(APPLE_BUTTON_ID));

    expect(appleSignIn).not.toHaveBeenCalled();
  });

  it('forwards a well-formed key to the Apple hook verbatim', () => {
    mockUseAppleAvailable.mockReturnValue(true);
    setAppleAuth({ status: 'needsLicense' });
    const { getByLabelText, getByTestId } = render(<SocialAuthButtons />);

    fireEvent.changeText(getByLabelText(LICENSE_LABEL), VALID_LICENSE_KEY);
    fireEvent.press(getByTestId(APPLE_LICENSE_SUBMIT_ID));

    expect(appleSubmitLicenseKey).toHaveBeenCalledWith(VALID_LICENSE_KEY);
    expect(submitLicenseKey).not.toHaveBeenCalled();
  });

  it('announces the Apple refusal in its own live region', () => {
    mockUseAppleAvailable.mockReturnValue(true);
    setAppleAuth({ status: 'needsLicense', error: REFUSAL_COPY });

    const { getByTestId } = render(<SocialAuthButtons />);
    const alert = getByTestId(APPLE_ERROR_ID);

    expect(alert).toHaveTextContent(REFUSAL_COPY);
    expect(alert.props.accessibilityRole).toBe('alert');
    expect(alert.props.accessibilityLiveRegion).toBe('polite');
  });
});

describe('SocialAuthButtons — Apple button theming', () => {
  // Apple's HIG: the button contrasts with the surface behind it, so the dark
  // canvas takes the white mark and the light canvas takes the black one.
  const THEME_CASES: Array<[ThemeMode, AppleAuthenticationButtonStyle]> = [
    ['dark', AppleAuthenticationButtonStyle.WHITE],
    ['light', AppleAuthenticationButtonStyle.BLACK],
  ];

  it.each(THEME_CASES)('uses the contrasting mark in %s mode', (mode, expected) => {
    mockUseAppleAvailable.mockReturnValue(true);

    const { getByTestId } = render(
      <ThemeProvider initialMode={mode}>
        <SocialAuthButtons />
      </ThemeProvider>,
    );

    expect(getByTestId(APPLE_BUTTON_ID).props.buttonStyle).toBe(expected);
  });
});
