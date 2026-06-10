/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import TimezoneSettingsScreen from '../TimezoneSettingsScreen';

import { ApiError, users } from '@/api';
import { useAuth } from '@/context/AuthContext';
import { detectDeviceTimezone } from '@/utils/dateUtils';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return { ...actual, users: { updateMyTimezone: jest.fn() } };
});

jest.mock('@/utils/dateUtils', () => {
  const actual = jest.requireActual('@/utils/dateUtils');
  return { ...actual, detectDeviceTimezone: jest.fn(() => 'Pacific/Auckland') };
});

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUpdateMyTimezone = users.updateMyTimezone as jest.MockedFunction<
  typeof users.updateMyTimezone
>;
const mockDetectDeviceTimezone = detectDeviceTimezone as jest.MockedFunction<
  typeof detectDeviceTimezone
>;

function setAuthState(userTimezone = 'Europe/Paris') {
  const setUserTimezone = jest.fn();
  mockUseAuth.mockReturnValue({
    userTimezone,
    setUserTimezone,
  } as unknown as ReturnType<typeof useAuth>);
  return { setUserTimezone };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDetectDeviceTimezone.mockReturnValue('Pacific/Auckland');
});

describe('TimezoneSettingsScreen', () => {
  test('shows the time zone the server has on record', () => {
    setAuthState('Europe/Paris');
    const { getByTestId } = render(<TimezoneSettingsScreen />);
    expect(getByTestId('current-timezone').props.children).toContain('Europe/Paris');
  });

  test('saves a new zone and pushes it into the auth context on success', async () => {
    const { setUserTimezone } = setAuthState('Europe/Paris');
    mockUpdateMyTimezone.mockResolvedValueOnce({ timezone: 'America/Los_Angeles' });
    const { getByTestId } = render(<TimezoneSettingsScreen />);

    fireEvent.changeText(getByTestId('timezone-input'), 'America/Los_Angeles');
    fireEvent.press(getByTestId('save-timezone-button'));

    await waitFor(() => {
      expect(mockUpdateMyTimezone).toHaveBeenCalledWith({ timezone: 'America/Los_Angeles' });
      expect(setUserTimezone).toHaveBeenCalledWith('America/Los_Angeles');
      expect(getByTestId('timezone-status')).toBeTruthy();
    });
  });

  test('shows a friendly error on a 422 and leaves the auth context untouched', async () => {
    const { setUserTimezone } = setAuthState('Europe/Paris');
    mockUpdateMyTimezone.mockRejectedValueOnce(
      new ApiError(422, "unknown IANA timezone: 'Mars/Phobos'"),
    );
    const { getByTestId } = render(<TimezoneSettingsScreen />);

    fireEvent.changeText(getByTestId('timezone-input'), 'Mars/Phobos');
    fireEvent.press(getByTestId('save-timezone-button'));

    await waitFor(() => {
      expect(getByTestId('timezone-error').props.children).toMatch(/recognized time zone/i);
    });
    expect(setUserTimezone).not.toHaveBeenCalled();
  });

  test('"Use device time zone" fills the input with the detected zone', () => {
    setAuthState('UTC');
    const { getByTestId } = render(<TimezoneSettingsScreen />);

    fireEvent.press(getByTestId('use-device-timezone-button'));

    expect(getByTestId('timezone-input').props.value).toBe('Pacific/Auckland');
  });

  test('the Back link calls navigation.goBack', () => {
    setAuthState('Europe/Paris');
    const goBack = jest.fn();
    const { getByText } = render(<TimezoneSettingsScreen navigation={{ goBack }} />);

    fireEvent.press(getByText('Back'));

    expect(goBack).toHaveBeenCalledTimes(1);
  });

  test('a blank zone never reaches the API', () => {
    setAuthState('Europe/Paris');
    const { getByTestId } = render(<TimezoneSettingsScreen />);

    fireEvent.changeText(getByTestId('timezone-input'), '   ');
    fireEvent.press(getByTestId('save-timezone-button'));

    expect(mockUpdateMyTimezone).not.toHaveBeenCalled();
    expect(getByTestId('timezone-error')).toBeTruthy();
  });
});
