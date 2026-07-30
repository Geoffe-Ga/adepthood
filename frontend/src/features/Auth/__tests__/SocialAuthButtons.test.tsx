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
/** The shared stem both providers' license fields extend — never an accessible name on its own. */
const LICENSE_LABEL = 'Gumroad license key';
const GOOGLE_LICENSE_LABEL = `${LICENSE_LABEL} for Google sign-in`;
const APPLE_LICENSE_LABEL = `${LICENSE_LABEL} for Apple sign-in`;
/** The help link's name is scoped the same way, and for the same reason. */
const HELP_LABEL = 'Find your license key';
const GOOGLE_HELP_LABEL = `${HELP_LABEL} for Google sign-in`;
const APPLE_HELP_LABEL = `${HELP_LABEL} for Apple sign-in`;
const SUBMIT_LABEL = 'Submit license key';
const GOOGLE_SUBMIT_LABEL = `${SUBMIT_LABEL} for Google sign-in`;
const APPLE_SUBMIT_LABEL = `${SUBMIT_LABEL} for Apple sign-in`;
const LICENSE_SUBMIT_ID = 'social-auth-license-submit';
const GOOGLE_BUTTON_ID = 'social-auth-google';
const GOOGLE_ERROR_ID = 'social-auth-error';
const GOOGLE_LICENSE_HELP_ID = 'social-auth-google-license-help';
const APPLE_BUTTON_ID = 'social-auth-apple';
const APPLE_ERROR_ID = 'social-auth-apple-error';
const APPLE_LICENSE_SUBMIT_ID = 'social-auth-apple-license-submit';
const APPLE_LICENSE_HELP_ID = 'social-auth-apple-license-help';
/**
 * The unscoped identifiers ``LicenseKeyField`` still defaults to for the signup
 * form's single field. Two providers on one screen may not share them.
 */
const UNSCOPED_LICENSE_ERROR_ID = 'signup-license-error';
const UNSCOPED_LICENSE_HELP_ID = 'signup-license-help';
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

/** Every string value of one prop, in render order, across the whole tree. */
function collectProp(node: unknown, key: string): string[] {
  if (Array.isArray(node)) return node.flatMap((child) => collectProp(child, key));
  if (node === null || typeof node !== 'object') return [];
  const { props, children } = node as RenderedNode;
  const value = props === undefined ? undefined : props[key];
  const own = typeof value === 'string' ? [value] : [];
  return [...own, ...collectProp(children ?? [], key)];
}

/**
 * Every testID in render order. Comparing these sequences pins layout: a
 * hidden placeholder for an absent provider would show up as an extra slot.
 */
function testIdsOf(node: unknown): string[] {
  return collectProp(node, 'testID');
}

/** Every accessible name in render order — what a screen reader would announce. */
function labelsOf(node: unknown): string[] {
  return collectProp(node, 'accessibilityLabel');
}

/** Only the names belonging to a license field, so unrelated controls cannot mask a clash. */
function licenseLabelsOf(node: unknown): string[] {
  return labelsOf(node).filter((label) => label.startsWith(LICENSE_LABEL));
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

    expect(getByLabelText(GOOGLE_LICENSE_LABEL)).toBeTruthy();
    expect(getByLabelText(GOOGLE_LABEL)).toBeTruthy();
    expect(signIn).not.toHaveBeenCalled();
  });

  it('hides the license field while idle', () => {
    const { toJSON } = render(<SocialAuthButtons />);

    expect(licenseLabelsOf(toJSON())).toEqual([]);
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

    fireEvent.changeText(getByLabelText(GOOGLE_LICENSE_LABEL), VALID_LICENSE_KEY);
    fireEvent.press(getByTestId(LICENSE_SUBMIT_ID));

    expect(submitLicenseKey).toHaveBeenCalledWith(VALID_LICENSE_KEY);
  });
});

describe('SocialAuthButtons — client-side license validation', () => {
  it('does not call the hook when the key is too short', () => {
    setGoogleAuth({ status: 'needsLicense' });
    const { getByLabelText, getByTestId, getByRole } = render(<SocialAuthButtons />);

    fireEvent.changeText(getByLabelText(GOOGLE_LICENSE_LABEL), TOO_SHORT_KEY);
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
    fireEvent.changeText(getByLabelText(GOOGLE_LICENSE_LABEL), VALID_LICENSE_KEY);
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

    // Without this the baseline could be empty — an ``AppleSignIn`` that always
    // returned null would satisfy the comparison below and prove nothing.
    expect(withApple).toContain(APPLE_BUTTON_ID);
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

    fireEvent.changeText(getByLabelText(APPLE_LICENSE_LABEL), VALID_LICENSE_KEY);
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

// Nothing disables one provider's button while the other is mid-flow, so both
// license steps can be on screen at once. Two fields announcing the same name,
// or two nodes answering to the same testID, make the pair unusable by voice
// control and ambiguous to a screen reader.
describe('SocialAuthButtons — both providers at the license step', () => {
  function renderBothLicenseSteps(error: string | null = null) {
    mockUseAppleAvailable.mockReturnValue(true);
    setGoogleAuth({ status: 'needsLicense', error });
    setAppleAuth({ status: 'needsLicense', error });
    return render(<SocialAuthButtons />);
  }

  it('gives each license field an accessible name naming its provider', () => {
    const { queryAllByLabelText } = renderBothLicenseSteps();

    expect(queryAllByLabelText(GOOGLE_LICENSE_LABEL)).toHaveLength(1);
    expect(queryAllByLabelText(APPLE_LICENSE_LABEL)).toHaveLength(1);
    expect(queryAllByLabelText(LICENSE_LABEL)).toHaveLength(0);
  });

  it('leaves no two license fields sharing an accessible name', () => {
    const { toJSON } = renderBothLicenseSteps();
    const names = licenseLabelsOf(toJSON());

    expect(names).toEqual([GOOGLE_LICENSE_LABEL, APPLE_LICENSE_LABEL]);
  });

  it('scopes each help link to its own provider', () => {
    const { getByTestId, queryAllByTestId } = renderBothLicenseSteps();

    expect(getByTestId(GOOGLE_LICENSE_HELP_ID)).toBeTruthy();
    expect(getByTestId(APPLE_LICENSE_HELP_ID)).toBeTruthy();
    expect(queryAllByTestId(UNSCOPED_LICENSE_HELP_ID)).toHaveLength(0);
    // A shared testID is only half the clash: two links reading out the same
    // name are just as ambiguous to a screen reader and to voice control.
    expect(getByTestId(GOOGLE_LICENSE_HELP_ID).props.accessibilityLabel).toBe(GOOGLE_HELP_LABEL);
    expect(getByTestId(APPLE_LICENSE_HELP_ID).props.accessibilityLabel).toBe(APPLE_HELP_LABEL);
    expect(GOOGLE_HELP_LABEL).not.toBe(APPLE_HELP_LABEL);
  });

  it('names each submit button for the provider it finishes', () => {
    const { getByTestId, queryAllByLabelText } = renderBothLicenseSteps();

    expect(getByTestId(LICENSE_SUBMIT_ID).props.accessibilityLabel).toBe(GOOGLE_SUBMIT_LABEL);
    expect(getByTestId(APPLE_LICENSE_SUBMIT_ID).props.accessibilityLabel).toBe(APPLE_SUBMIT_LABEL);
    expect(queryAllByLabelText(SUBMIT_LABEL)).toHaveLength(0);
  });

  it('keeps the two error slots on distinct testIDs', () => {
    const { getByTestId, queryAllByTestId } = renderBothLicenseSteps(REFUSAL_COPY);

    expect(getByTestId(GOOGLE_ERROR_ID)).toHaveTextContent(REFUSAL_COPY);
    expect(getByTestId(APPLE_ERROR_ID)).toHaveTextContent(REFUSAL_COPY);
    expect(queryAllByTestId(UNSCOPED_LICENSE_ERROR_ID)).toHaveLength(0);
  });

  it('answers every testID exactly once with both license steps open', () => {
    const ids = testIdsOf(renderBothLicenseSteps(REFUSAL_COPY).toJSON());

    expect(ids).toContain(GOOGLE_BUTTON_ID);
    expect(ids).toContain(APPLE_BUTTON_ID);
    expect([...new Set(ids)]).toEqual(ids);
  });

  it('still routes each submitted key to its own provider', () => {
    const { getByLabelText, getByTestId } = renderBothLicenseSteps();

    fireEvent.changeText(getByLabelText(APPLE_LICENSE_LABEL), VALID_LICENSE_KEY);
    fireEvent.press(getByTestId(APPLE_LICENSE_SUBMIT_ID));

    expect(appleSubmitLicenseKey).toHaveBeenCalledWith(VALID_LICENSE_KEY);
    expect(submitLicenseKey).not.toHaveBeenCalled();
  });
});
