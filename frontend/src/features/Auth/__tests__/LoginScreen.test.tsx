/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/context/AuthContext', () => {
  const login = jest.fn(() => Promise.resolve());
  return {
    useAuth: () => ({ login, token: null }),
    _mockLogin: login,
  };
});

jest.mock('../SocialAuthButtons', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    SocialAuthButtons: () =>
      ReactModule.createElement(Text, { testID: 'social-auth-section' }, 'Continue with Google'),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { _mockLogin: mockLogin } = require('@/context/AuthContext') as any;

import LoginScreen from '../LoginScreen';

import { UNREACHABLE_MESSAGE } from '@/api/errorMessages';

const SOCIAL_SECTION_ID = 'social-auth-section';
const ERROR_ID = 'login-error';

/** The accessibility hint a control is currently advertising, if any. */
function hintOf(input: { props: { accessibilityHint?: string } }): string | undefined {
  return input.props.accessibilityHint;
}
const VALID_EMAIL = 'user@test.com';
const VALID_PASSWORD = 'password123'; // pragma: allowlist secret

/** Rendered testIDs in tree order, so "below" is a real assertion. */
function testIdOrder(node: unknown, ids: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return ids;
  const element = node as { props?: { testID?: string }; children?: unknown[] };
  const testID = element.props === undefined ? undefined : element.props.testID;
  if (typeof testID === 'string') ids.push(testID);
  const children = Array.isArray(element.children) ? element.children : [];
  for (const child of children) testIdOrder(child, ids);
  return ids;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LoginScreen', () => {
  const mockNavigation = { navigate: jest.fn() };

  it('renders email and password fields', () => {
    const { getByPlaceholderText } = render(<LoginScreen navigation={mockNavigation} />);

    expect(getByPlaceholderText('Email')).toBeTruthy();
    expect(getByPlaceholderText('Password')).toBeTruthy();
  });

  it('renders a login button', () => {
    const { getByText } = render(<LoginScreen navigation={mockNavigation} />);

    expect(getByText('Log In')).toBeTruthy();
  });

  it('opens on the branded editorial cover: serif wordmark + program voice', () => {
    const { getByTestId, getByText } = render(<LoginScreen navigation={mockNavigation} />);

    expect(getByTestId('auth-brand-band')).toBeTruthy();
    expect(getByText('Adepthood')).toBeTruthy();
    expect(getByText(/thirty-six week/i)).toBeTruthy();
  });

  it('shows the "Welcome back" serif title', () => {
    const { getByText } = render(<LoginScreen navigation={mockNavigation} />);

    expect(getByText('Welcome back')).toBeTruthy();
  });

  it('calls login with email and password on submit', async () => {
    mockLogin.mockResolvedValue(undefined);
    const { getByPlaceholderText, getByText } = render(<LoginScreen navigation={mockNavigation} />);

    fireEvent.changeText(getByPlaceholderText('Email'), 'user@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'password123');
    fireEvent.press(getByText('Log In'));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('user@test.com', 'password123');
    });
  });

  it('translates the backend invalid_credentials code to user-facing copy', async () => {
    // The backend returns the stable code ``invalid_credentials`` (see
    // backend/src/routers/auth.py). The screen must not leak snake_case to
    // the user — it should display the mapped friendly message instead.
    mockLogin.mockRejectedValue({ detail: 'invalid_credentials', status: 401 });
    const { getByPlaceholderText, getByText, findByText, queryByText } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), 'user@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'wrong');
    fireEvent.press(getByText('Log In'));

    expect(await findByText(/email and password/i)).toBeTruthy();
    expect(queryByText('invalid_credentials')).toBeNull();
  });

  // Renamed from "when the error is unrecognised": the old title generalised a
  // genuine transport failure into "anything we don't recognise is the network",
  // which is exactly the belief that let a server's 422 wear connectivity copy.
  // The body always described a real fetch failure; the assertion is tightened
  // to the exact transport copy so it can never again pass on a status error.
  it('keeps connectivity copy for a genuine transport failure', async () => {
    mockLogin.mockRejectedValue(new TypeError('Network request failed'));
    const { getByPlaceholderText, getByText, findByText } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), VALID_EMAIL);
    fireEvent.changeText(getByPlaceholderText('Password'), 'whatever');
    fireEvent.press(getByText('Log In'));

    expect(await findByText(UNREACHABLE_MESSAGE)).toBeTruthy();
  });

  it('trims whitespace from the email before submitting (BUG-AUTH-010)', async () => {
    mockLogin.mockResolvedValue(undefined);
    const { getByPlaceholderText, getByText } = render(<LoginScreen navigation={mockNavigation} />);

    fireEvent.changeText(getByPlaceholderText('Email'), '  user@test.com\n');
    fireEvent.changeText(getByPlaceholderText('Password'), 'password123');
    fireEvent.press(getByText('Log In'));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('user@test.com', 'password123');
    });
  });

  it('lowercases the email before submitting (BUG-FE-AUTH-015)', async () => {
    // ``Foo@Bar.com`` and ``foo@bar.com`` must hit the backend as the same
    // canonical address so a user can't end up locked out of the account
    // they just created with mixed case.
    mockLogin.mockResolvedValue(undefined);
    const { getByPlaceholderText, getByText } = render(<LoginScreen navigation={mockNavigation} />);

    fireEvent.changeText(getByPlaceholderText('Email'), '  Foo@Bar.COM ');
    fireEvent.changeText(getByPlaceholderText('Password'), 'password123');
    fireEvent.press(getByText('Log In'));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('foo@bar.com', 'password123');
    });
  });

  it('has a link to navigate to signup', () => {
    const { getByText } = render(<LoginScreen navigation={mockNavigation} />);

    fireEvent.press(getByText('Sign Up'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Signup');
  });

  it('navigates to ForgotPassword when the "Forgot password?" link is tapped', () => {
    const { getByTestId } = render(<LoginScreen navigation={mockNavigation} />);
    fireEvent.press(getByTestId('login-forgot-password'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('ForgotPassword');
  });

  it('offers the social sign-in section', () => {
    const { getByTestId } = render(<LoginScreen navigation={mockNavigation} />);

    expect(getByTestId(SOCIAL_SECTION_ID)).toBeTruthy();
  });

  // Email/password stays the primary path; Google is the alternative offered
  // underneath it, not the headline.
  it('places the social section below the primary login action', () => {
    const { toJSON } = render(<LoginScreen navigation={mockNavigation} />);
    const ids = testIdOrder(toJSON());

    expect(ids).toContain('login-submit');
    expect(ids.indexOf(SOCIAL_SECTION_ID)).toBeGreaterThan(ids.indexOf('login-submit'));
  });
});

describe('LoginScreen required fields (#2821)', () => {
  const mockNavigation = { navigate: jest.fn() };

  it('blocks submission and names both missing fields instead of blaming the connection', async () => {
    mockLogin.mockResolvedValue(undefined);
    const { getByText, findByTestId, queryByText } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.press(getByText('Log In'));

    // Asserted first because it is synchronous: the guard returns before the
    // async path, so there is no pending call to wait for.
    expect(mockLogin).not.toHaveBeenCalled();
    const banner = await findByTestId(ERROR_ID);
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(banner.props.accessibilityLiveRegion).toBe('polite');
    expect(banner).toHaveTextContent(/email/i);
    expect(banner).toHaveTextContent(/password/i);
    expect(queryByText(/Check your connection/i)).toBeNull();
  });

  it('names only the email when the password is filled', async () => {
    const { getByPlaceholderText, getByText, findByTestId } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Password'), VALID_PASSWORD);
    fireEvent.press(getByText('Log In'));

    expect(mockLogin).not.toHaveBeenCalled();
    const banner = await findByTestId(ERROR_ID);
    expect(banner).toHaveTextContent('Enter your email to continue.');
  });

  it('names only the password when the email is filled', async () => {
    const { getByPlaceholderText, getByText, findByTestId } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), VALID_EMAIL);
    fireEvent.press(getByText('Log In'));

    expect(mockLogin).not.toHaveBeenCalled();
    const banner = await findByTestId(ERROR_ID);
    expect(banner).toHaveTextContent('Enter your password to continue.');
  });

  it('treats a whitespace-only email as missing', async () => {
    const { getByPlaceholderText, getByText, findByTestId } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), '   ');
    fireEvent.changeText(getByPlaceholderText('Password'), VALID_PASSWORD);
    fireEvent.press(getByText('Log In'));

    expect(mockLogin).not.toHaveBeenCalled();
    expect(await findByTestId(ERROR_ID)).toHaveTextContent('Enter your email to continue.');
  });

  // A screen reader user who swipes from the banner to the control must hear
  // that this is the field in question -- the banner alone leaves them counting.
  it('marks the blank input with a required hint', async () => {
    const { getByPlaceholderText, getByText, findByTestId } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Password'), VALID_PASSWORD);
    fireEvent.press(getByText('Log In'));
    await findByTestId(ERROR_ID);

    expect(getByPlaceholderText('Email').props.accessibilityHint).toBe('Required.');
    expect(getByPlaceholderText('Password').props.accessibilityHint).toBeUndefined();
  });

  // F1: the banner names what is still missing. Clearing a *filled* field to
  // retype it leaves the form more invalid, not less, so neither the banner nor
  // the control's hint may disappear on that keystroke.
  it('keeps the message when a different field is cleared to be retyped', async () => {
    const { getByPlaceholderText, getByText, findByTestId } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), VALID_EMAIL);
    fireEvent.press(getByText('Log In'));
    const banner = await findByTestId(ERROR_ID);
    expect(banner).toHaveTextContent('Enter your password to continue.');

    fireEvent.changeText(getByPlaceholderText('Email'), '');

    expect(hintOf(getByPlaceholderText('Password'))).toBe('Required.');
    expect(getByText('Enter your password to continue.')).toBeTruthy();
  });

  it('retracts the message as soon as the offending field is edited', async () => {
    const { getByPlaceholderText, getByText, findByTestId, queryByTestId } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.press(getByText('Log In'));
    await findByTestId(ERROR_ID);

    fireEvent.changeText(getByPlaceholderText('Email'), VALID_EMAIL);
    fireEvent.changeText(getByPlaceholderText('Password'), VALID_PASSWORD);

    expect(queryByTestId(ERROR_ID)).toBeNull();
  });

  it('submits on Enter exactly as the button does', async () => {
    mockLogin.mockResolvedValue(undefined);
    const { getByPlaceholderText, findByTestId, queryByTestId } = render(
      <LoginScreen navigation={mockNavigation} />,
    );
    const password = getByPlaceholderText('Password');

    fireEvent(password, 'submitEditing');

    expect(mockLogin).not.toHaveBeenCalled();
    expect(await findByTestId(ERROR_ID)).toBeTruthy();

    fireEvent.changeText(getByPlaceholderText('Email'), VALID_EMAIL);
    fireEvent.changeText(password, VALID_PASSWORD);
    fireEvent(getByPlaceholderText('Password'), 'submitEditing');

    await waitFor(() => expect(mockLogin).toHaveBeenCalledTimes(1));
    expect(mockLogin).toHaveBeenCalledWith(VALID_EMAIL, VALID_PASSWORD);
    expect(queryByTestId(ERROR_ID)).toBeNull();
  });

  // The guard measures the password exactly as it will be sent. An account whose
  // password is eight spaces is creatable and loggable-in today, so a trimmed
  // guard would lock that user out of this client for good while telling them to
  // type the password they are holding. The server answers; the client does not.
  it('still submits an all-whitespace password so the server answers, not the client', async () => {
    mockLogin.mockResolvedValue(undefined);
    const { getByPlaceholderText, getByText } = render(<LoginScreen navigation={mockNavigation} />);

    fireEvent.changeText(getByPlaceholderText('Email'), VALID_EMAIL);
    fireEvent.changeText(getByPlaceholderText('Password'), '        ');
    fireEvent.press(getByText('Log In'));

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith(VALID_EMAIL, '        '));
  });
});

// F5: the four auth fallbacks used to diagnose a cause they could not know, and
// that is the whole defect this suite exists to hold shut. Pin the exact copy so
// a revert to "Check your connection" cannot pass.
describe('LoginScreen fallback copy', () => {
  const mockNavigation = { navigate: jest.fn() };

  it('never blames the connection for a failure it cannot classify', async () => {
    mockLogin.mockRejectedValue(new Error('something the client cannot classify'));
    const { getByPlaceholderText, getByText, findByTestId, queryByText } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), VALID_EMAIL);
    fireEvent.changeText(getByPlaceholderText('Password'), VALID_PASSWORD);
    fireEvent.press(getByText('Log In'));

    expect(await findByTestId(ERROR_ID)).toHaveTextContent(
      "We couldn't sign you in. Give it a moment, then try again.",
    );
    expect(queryByText(/connection/i)).toBeNull();
  });
});
