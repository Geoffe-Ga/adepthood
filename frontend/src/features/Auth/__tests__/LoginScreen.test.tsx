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

const SOCIAL_SECTION_ID = 'social-auth-section';

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

  it('falls back to a connection-hint message when the error is unrecognised', async () => {
    mockLogin.mockRejectedValue(new TypeError('Network request failed'));
    const { getByPlaceholderText, getByText, findByText } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), 'user@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'whatever');
    fireEvent.press(getByText('Log In'));

    expect(await findByText(/Check your connection/i)).toBeTruthy();
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
