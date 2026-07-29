/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

jest.mock('../useGoogleAuth', () => ({ useGoogleAuth: jest.fn() }));
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
import { useGoogleAuth } from '../useGoogleAuth';

const mockIsConfigured = isGoogleAuthConfigured as jest.MockedFunction<
  typeof isGoogleAuthConfigured
>;
const mockUseGoogleAuth = useGoogleAuth as unknown as jest.Mock;

const GOOGLE_LABEL = 'Continue with Google';
const LICENSE_LABEL = 'Gumroad license key';
const LICENSE_SUBMIT_ID = 'social-auth-license-submit';
const VALID_LICENSE_KEY = 'A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6'; // pragma: allowlist secret
const TOO_SHORT_KEY = 'abc'; // pragma: allowlist secret
const TOO_SHORT_COPY = 'That key looks too short — a Gumroad key is at least 8 characters.';
const KEY_REQUIRED_COPY = 'Add the license key from your Gumroad receipt to continue.';
const REFUSAL_COPY = 'A license key is needed to finish connecting this sign-in.';

const signIn = jest.fn();
const submitLicenseKey = jest.fn();

interface GoogleAuthState {
  status: 'idle' | 'needsLicense';
  error: string | null;
  submitting: boolean;
}

function setGoogleAuth(state: Partial<GoogleAuthState> = {}): void {
  mockUseGoogleAuth.mockReturnValue({
    status: state.status ?? 'idle',
    error: state.error ?? null,
    submitting: state.submitting ?? false,
    signIn,
    submitLicenseKey,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsConfigured.mockReturnValue(true);
  setGoogleAuth();
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
