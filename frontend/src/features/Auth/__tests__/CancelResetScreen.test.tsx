/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/api', () => {
  const cancelPasswordReset = jest.fn(() => Promise.resolve());
  return {
    auth: { cancelPasswordReset },
    _mockCancel: cancelPasswordReset,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { _mockCancel: mockCancel } = require('@/api') as any;

import CancelResetScreen from '../CancelResetScreen';

const navigation = { navigate: jest.fn() };
const VALID_TOKEN = 'a'.repeat(43);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CancelResetScreen', () => {
  it('shows the invalid-link view when no token is provided', () => {
    const { getByText } = render(<CancelResetScreen navigation={navigation} />);
    expect(getByText('Cancel Link Invalid')).toBeTruthy();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('shows the invalid-link view when the token is too short', () => {
    const { getByText } = render(
      <CancelResetScreen navigation={navigation} route={{ params: { token: 'tiny' } }} />,
    );
    expect(getByText('Cancel Link Invalid')).toBeTruthy();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('calls the cancel API on mount with a valid-shape token', async () => {
    mockCancel.mockResolvedValueOnce(undefined);
    render(
      <CancelResetScreen navigation={navigation} route={{ params: { token: VALID_TOKEN } }} />,
    );
    await waitFor(() => {
      expect(mockCancel).toHaveBeenCalledWith({ token: VALID_TOKEN });
    });
  });

  it('shows the success state after a 204 response', async () => {
    mockCancel.mockResolvedValueOnce(undefined);
    const { findByText } = render(
      <CancelResetScreen navigation={navigation} route={{ params: { token: VALID_TOKEN } }} />,
    );
    expect(await findByText('Reset Cancelled')).toBeTruthy();
  });

  it('shows the network-error state when the API call rejects', async () => {
    mockCancel.mockRejectedValueOnce(new TypeError('offline'));
    const { findByText } = render(
      <CancelResetScreen navigation={navigation} route={{ params: { token: VALID_TOKEN } }} />,
    );
    expect(await findByText('Could Not Reach Server')).toBeTruthy();
  });

  it('routes back to login from any terminal state', async () => {
    mockCancel.mockResolvedValueOnce(undefined);
    const { findByTestId } = render(
      <CancelResetScreen navigation={navigation} route={{ params: { token: VALID_TOKEN } }} />,
    );
    const back = await findByTestId('cancel-reset-back-to-login');
    fireEvent.press(back);
    expect(navigation.navigate).toHaveBeenCalledWith('Login');
  });
});
