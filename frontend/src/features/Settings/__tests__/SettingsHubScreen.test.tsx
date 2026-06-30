/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockNavigate = jest.fn();
const mockLogout = jest.fn(() => Promise.resolve());

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ logout: mockLogout }),
}));

import SettingsHubScreen from '../SettingsHubScreen';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SettingsHubScreen', () => {
  test('renders the Account and Session groups with their three rows', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-account')).toBeTruthy();
    expect(getByTestId('settings-group-session')).toBeTruthy();
    expect(getByTestId('settings-row-api-key')).toBeTruthy();
    expect(getByTestId('settings-row-timezone')).toBeTruthy();
    expect(getByTestId('settings-row-logout')).toBeTruthy();
  });

  test('tapping the API key row navigates to ApiKeySettings', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-api-key'));

    expect(mockNavigate).toHaveBeenCalledWith('ApiKeySettings');
  });

  test('tapping the time zone row navigates to TimezoneSettings', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-timezone'));

    expect(mockNavigate).toHaveBeenCalledWith('TimezoneSettings');
  });

  test('tapping Log out calls the logout action', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-logout'));

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});
