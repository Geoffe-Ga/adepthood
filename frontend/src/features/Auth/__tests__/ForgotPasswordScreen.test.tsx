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

import { FIELD_VALIDATION_MESSAGE, UNREACHABLE_MESSAGE } from '@/api/errorMessages';

const navigation = { navigate: jest.fn() };
const ERROR_ID = 'forgot-error';

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

  it('keeps the anti-enumeration success copy verbatim through the restyle', async () => {
    // design-act2-10: the restyle must not touch the SPEC R4 copy. Assert the
    // exact string still renders so a future style change can't quietly reword
    // the anti-enumeration body.
    mockRequest.mockResolvedValueOnce({ message: 'ok' });
    const { getByLabelText, getByText, findByText } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );
    fireEvent.changeText(getByLabelText('Email'), 'foo@example.com');
    fireEvent.press(getByText('Send Reset Link'));
    expect(
      await findByText(
        'If we have an account for that address, a reset link is on its way. The link expires in 30 minutes.',
      ),
    ).toBeTruthy();
  });

  // Renamed from "when the request fails entirely" and tightened to the exact
  // transport copy. After the 422 narrowing this is the negative control: it is
  // the only guard that the real offline path on this screen still says so.
  it('keeps connectivity copy when the request never reaches the server', async () => {
    mockRequest.mockRejectedValueOnce(new TypeError('Network request failed'));
    const { getByLabelText, getByText, findByText } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );
    fireEvent.changeText(getByLabelText('Email'), 'foo@example.com');
    fireEvent.press(getByText('Send Reset Link'));
    expect(await findByText(UNREACHABLE_MESSAGE)).toBeTruthy();
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

describe('ForgotPasswordScreen required email (#2822)', () => {
  it('blocks a blank email and spends no reset-request budget', async () => {
    const { getByText, findByTestId, queryByText } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );

    fireEvent.press(getByText('Send Reset Link'));

    // "the API client was not called" IS the zero-rate-limit-budget assertion:
    // SlowAPIMiddleware counts the request before the body is ever validated,
    // and this route allows three per hour.
    expect(mockRequest).not.toHaveBeenCalled();
    const banner = await findByTestId(ERROR_ID);
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(banner.props.accessibilityLiveRegion).toBe('polite');
    expect(banner).toHaveTextContent('Enter your email to continue.');
    expect(queryByText(/Check your connection/i)).toBeNull();
  });

  it('treats a whitespace-only email as blank', async () => {
    const { getByLabelText, getByText, findByTestId } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );

    fireEvent.changeText(getByLabelText('Email'), '   ');
    fireEvent.press(getByText('Send Reset Link'));

    expect(mockRequest).not.toHaveBeenCalled();
    expect(await findByTestId(ERROR_ID)).toHaveTextContent('Enter your email to continue.');
    expect(getByLabelText('Email').props.accessibilityHint).toBe('Required.');
  });

  it('retracts the message once an address is typed', async () => {
    const { getByLabelText, getByText, findByTestId, queryByTestId } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );

    fireEvent.press(getByText('Send Reset Link'));
    await findByTestId(ERROR_ID);

    fireEvent.changeText(getByLabelText('Email'), 'foo@example.com');

    expect(queryByTestId(ERROR_ID)).toBeNull();
  });

  it('submits on Enter exactly as the button does', async () => {
    mockRequest.mockResolvedValueOnce({ message: 'ok' });
    const { getByLabelText, findByTestId, findByText } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );
    const field = getByLabelText('Email');

    fireEvent(field, 'submitEditing');
    expect(mockRequest).not.toHaveBeenCalled();
    expect(await findByTestId(ERROR_ID)).toBeTruthy();

    fireEvent.changeText(getByLabelText('Email'), 'foo@example.com');
    fireEvent(getByLabelText('Email'), 'submitEditing');

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ email: 'foo@example.com' }));
    expect(await findByText('Check your inbox')).toBeTruthy();
  });

  it('renders field-validation copy for a server 422 rather than a connection story', async () => {
    mockRequest.mockRejectedValueOnce({ detail: 'some_unmapped_code', status: 422 });
    const { getByLabelText, getByText, findByTestId, queryByText } = render(
      <ForgotPasswordScreen navigation={navigation} />,
    );

    fireEvent.changeText(getByLabelText('Email'), 'not-an-email@');
    fireEvent.press(getByText('Send Reset Link'));

    expect(await findByTestId(ERROR_ID)).toHaveTextContent(FIELD_VALIDATION_MESSAGE);
    expect(queryByText(/Check your connection/i)).toBeNull();
  });
});
