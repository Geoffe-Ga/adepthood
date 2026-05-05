/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/context/AuthContext', () => {
  const confirmPasswordReset = jest.fn(() => Promise.resolve());
  return {
    useAuth: () => ({ confirmPasswordReset }),
    _mockConfirm: confirmPasswordReset,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { _mockConfirm: mockConfirm } = require('@/context/AuthContext') as any;

import ResetPasswordScreen from '../ResetPasswordScreen';

const navigation = { navigate: jest.fn() };
const VALID_TOKEN = 'a'.repeat(43);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ResetPasswordScreen', () => {
  it('shows the missing-token view when no token is supplied', () => {
    const { getByText } = render(<ResetPasswordScreen navigation={navigation} />);
    expect(getByText('Reset Link Invalid')).toBeTruthy();
  });

  it('shows the missing-token view when the token is too short', () => {
    const { getByText } = render(
      <ResetPasswordScreen navigation={navigation} route={{ params: { token: 'tiny' } }} />,
    );
    expect(getByText('Reset Link Invalid')).toBeTruthy();
  });

  it('renders both password fields when a valid token is provided', () => {
    const { getByLabelText } = render(
      <ResetPasswordScreen navigation={navigation} route={{ params: { token: VALID_TOKEN } }} />,
    );
    expect(getByLabelText('New password')).toBeTruthy();
    expect(getByLabelText('Confirm new password')).toBeTruthy();
  });

  it('rejects passwords shorter than 8 characters before calling the backend', async () => {
    const { getByLabelText, getByText, findByText } = render(
      <ResetPasswordScreen navigation={navigation} route={{ params: { token: VALID_TOKEN } }} />,
    );
    fireEvent.changeText(getByLabelText('New password'), 'short');
    fireEvent.changeText(getByLabelText('Confirm new password'), 'short');
    fireEvent.press(getByText('Set Password'));
    expect(await findByText(/at least 8 characters long/i)).toBeTruthy();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords before calling the backend', async () => {
    const { getByLabelText, getByText, findByText } = render(
      <ResetPasswordScreen navigation={navigation} route={{ params: { token: VALID_TOKEN } }} />,
    );
    fireEvent.changeText(getByLabelText('New password'), 'longenough');
    fireEvent.changeText(getByLabelText('Confirm new password'), 'different1');
    fireEvent.press(getByText('Set Password'));
    expect(await findByText(/passwords don/i)).toBeTruthy();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('calls confirmPasswordReset with the token + new password when valid', async () => {
    mockConfirm.mockResolvedValueOnce(undefined);
    const { getByLabelText, getByText } = render(
      <ResetPasswordScreen navigation={navigation} route={{ params: { token: VALID_TOKEN } }} />,
    );
    fireEvent.changeText(getByLabelText('New password'), 'longenough');
    fireEvent.changeText(getByLabelText('Confirm new password'), 'longenough');
    fireEvent.press(getByText('Set Password'));
    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith(VALID_TOKEN, 'longenough');
    });
  });

  it('surfaces a friendly error when the backend rejects the token', async () => {
    mockConfirm.mockRejectedValueOnce({ status: 400, detail: 'invalid_or_expired_token' });
    const { getByLabelText, getByText, findByText } = render(
      <ResetPasswordScreen navigation={navigation} route={{ params: { token: VALID_TOKEN } }} />,
    );
    fireEvent.changeText(getByLabelText('New password'), 'longenough');
    fireEvent.changeText(getByLabelText('Confirm new password'), 'longenough');
    fireEvent.press(getByText('Set Password'));
    expect(await findByText(/expired/i)).toBeTruthy();
  });

  it('lets the user request a new link from the missing-token view', () => {
    const { getByTestId } = render(<ResetPasswordScreen navigation={navigation} />);
    fireEvent.press(getByTestId('reset-request-new'));
    expect(navigation.navigate).toHaveBeenCalledWith('ForgotPassword');
  });
});
