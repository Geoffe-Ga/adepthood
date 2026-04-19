/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

/**
 * BUG-NAV-001 follow-up — the ReauthSheet is the user-facing surface of the
 * ``'reauth-required'`` state. These tests pin down its form wiring, error
 * rendering, submit lifecycle, and the dismiss-during-submit race that
 * @claude[bot] flagged on #245.
 */
const mockLogin = jest.fn<Promise<void>, [string, string]>();
const mockDismissReauth = jest.fn<Promise<void>, []>();

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    token: null,
    authStatus: 'reauth-required',
    isLoading: false,
    login: mockLogin,
    signup: jest.fn(),
    logout: jest.fn(),
    onUnauthorized: jest.fn(),
    dismissReauth: mockDismissReauth,
  }),
}));

jest.mock('@/api/errorMessages', () => ({
  formatApiError: (_err: unknown, { fallback }: { fallback: string }) =>
    (_err as { message?: string })?.message ?? fallback,
}));

import { ReauthSheet } from '@/features/Auth/ReauthSheet';

beforeEach(() => {
  mockLogin.mockReset();
  mockDismissReauth.mockReset();
  mockLogin.mockResolvedValue(undefined);
  mockDismissReauth.mockResolvedValue(undefined);
});

describe('ReauthSheet', () => {
  it('renders email + password fields and both action buttons', () => {
    const { getByTestId } = render(<ReauthSheet />);
    expect(getByTestId('reauth-email')).toBeTruthy();
    expect(getByTestId('reauth-password')).toBeTruthy();
    expect(getByTestId('reauth-submit')).toBeTruthy();
    expect(getByTestId('reauth-dismiss')).toBeTruthy();
  });

  it('calls login(email.trim(), password) when submit is pressed', async () => {
    const { getByTestId } = render(<ReauthSheet />);
    fireEvent.changeText(getByTestId('reauth-email'), '  user@example.com  ');
    fireEvent.changeText(getByTestId('reauth-password'), 'secret'); // pragma: allowlist secret
    fireEvent.press(getByTestId('reauth-submit'));

    await waitFor(
      () => expect(mockLogin).toHaveBeenCalledWith('user@example.com', 'secret'), // pragma: allowlist secret
    );
  });

  it('displays the formatted error when login rejects', async () => {
    mockLogin.mockRejectedValueOnce(new Error('Invalid credentials'));
    const { getByTestId, findByText } = render(<ReauthSheet />);
    fireEvent.changeText(getByTestId('reauth-email'), 'a@b.co');
    fireEvent.changeText(getByTestId('reauth-password'), 'pw'); // pragma: allowlist secret
    fireEvent.press(getByTestId('reauth-submit'));

    expect(await findByText('Invalid credentials')).toBeTruthy();
  });

  it('calls dismissReauth when "Sign out instead" is pressed', () => {
    const { getByTestId } = render(<ReauthSheet />);
    fireEvent.press(getByTestId('reauth-dismiss'));
    expect(mockDismissReauth).toHaveBeenCalledTimes(1);
  });

  // BUG-NAV-001 review follow-up: if dismiss fires while a login is in flight,
  // the login completion races the dismiss and can silently log the user back
  // in after they chose to sign out. Disable the dismiss button while
  // submitting so the race is impossible by construction.
  it('disables the dismiss button while a login is in flight', () => {
    const resolveLoginRef: { current: (() => void) | null } = { current: null };
    mockLogin.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLoginRef.current = () => resolve();
        }),
    );

    const { getByTestId } = render(<ReauthSheet />);
    fireEvent.changeText(getByTestId('reauth-email'), 'a@b.co');
    fireEvent.changeText(getByTestId('reauth-password'), 'pw'); // pragma: allowlist secret
    fireEvent.press(getByTestId('reauth-submit'));

    const dismiss = getByTestId('reauth-dismiss');
    expect(dismiss.props.accessibilityState?.disabled).toBe(true);

    // Tapping the disabled dismiss must be a no-op so the mid-flight login
    // cannot be silently superseded by a logout.
    fireEvent.press(dismiss);
    expect(mockDismissReauth).not.toHaveBeenCalled();

    resolveLoginRef.current?.();
  });

  it('re-enables the dismiss button once the login promise settles', async () => {
    mockLogin.mockRejectedValueOnce(new Error('nope'));
    const { getByTestId } = render(<ReauthSheet />);
    fireEvent.changeText(getByTestId('reauth-email'), 'a@b.co');
    fireEvent.changeText(getByTestId('reauth-password'), 'pw'); // pragma: allowlist secret
    fireEvent.press(getByTestId('reauth-submit'));

    await waitFor(() =>
      expect(getByTestId('reauth-dismiss').props.accessibilityState?.disabled).toBe(false),
    );
  });
});
