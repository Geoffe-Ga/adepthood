/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/api', () => {
  const requestPasswordReset = jest.fn(() => Promise.resolve({ message: 'ok' }));
  return {
    auth: { requestPasswordReset },
    _mockRequestPasswordReset: requestPasswordReset,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { _mockRequestPasswordReset: mockRequest } = require('@/api') as any;

import ForgotPasswordScreen from '../ForgotPasswordScreen';

const navigation = { navigate: jest.fn(), goBack: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ForgotPasswordScreen', () => {
  it('renders the email field with an accessible label', () => {
    const { getByLabelText } = render(<ForgotPasswordScreen navigation={navigation} />);
    expect(getByLabelText('Email')).toBeTruthy();
  });

  it('submits a normalized lowercase email and shows the generic success view', async () => {
    mockRequest.mockResolvedValueOnce({ message: 'ok' });
    const { getByLabelText, getByText, findByText } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );
    fireEvent.changeText(getByLabelText('Email'), '  Foo@Bar.COM ');
    fireEvent.press(getByText('Send Reset Link'));
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith({ email: 'foo@bar.com' });
    });
    expect(await findByText('Check your inbox')).toBeTruthy();
  });

  it('does not distinguish unknown emails -- the success state is identical', async () => {
    // SPEC R4: the user must see the same UI regardless of whether the
    // email is registered.  Backend always returns 202.
    mockRequest.mockResolvedValueOnce({ message: 'ok' });
    const { getByLabelText, getByText, findByText } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );
    fireEvent.changeText(getByLabelText('Email'), 'never-existed@example.com');
    fireEvent.press(getByText('Send Reset Link'));
    expect(await findByText('Check your inbox')).toBeTruthy();
  });

  it('surfaces a friendly error when the request fails entirely', async () => {
    mockRequest.mockRejectedValueOnce(new TypeError('Network request failed'));
    const { getByLabelText, getByText, findByText } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );
    fireEvent.changeText(getByLabelText('Email'), 'foo@example.com');
    fireEvent.press(getByText('Send Reset Link'));
    expect(await findByText(/Check your connection/i)).toBeTruthy();
  });

  it('routes back to login from the success view', async () => {
    mockRequest.mockResolvedValueOnce({ message: 'ok' });
    const { getByLabelText, getByText, findByTestId } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );
    fireEvent.changeText(getByLabelText('Email'), 'foo@example.com');
    fireEvent.press(getByText('Send Reset Link'));
    const back = await findByTestId('forgot-back-to-login');
    fireEvent.press(back);
    expect(navigation.navigate).toHaveBeenCalledWith('Login');
  });

  it('routes back to login from the entry view via the link', () => {
    const { getByText } = render(<ForgotPasswordScreen navigation={navigation} />);
    fireEvent.press(getByText('Log In'));
    expect(navigation.navigate).toHaveBeenCalledWith('Login');
  });
});
