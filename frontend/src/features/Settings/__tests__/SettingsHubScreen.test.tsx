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

// ---------------------------------------------------------------------------
// Issue #892 — "Support & care" row additions (RED — fails until impl exists)
// ---------------------------------------------------------------------------

describe('SettingsHubScreen — Support & care row (issue #892)', () => {
  test('renders the "Support & care" row with testID "settings-row-support"', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    // This row does not exist until the implementation-specialist adds it.
    // The test will fail with "Unable to find an element with testID: settings-row-support".
    expect(getByTestId('settings-row-support')).toBeTruthy();
  });

  test('the "Support & care" row has accessible label text "Support & care"', () => {
    const { getByTestId } = render(<SettingsHubScreen />);
    const row = getByTestId('settings-row-support');
    expect(row.props.accessibilityLabel).toBe('Support & care');
  });

  test('tapping "settings-row-support" navigates to SupportCare', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-support'));

    expect(mockNavigate).toHaveBeenCalledWith('SupportCare');
  });

  test('the existing rows are unaffected by the new Support & care row', () => {
    // Regression: the original three rows must still render after the new row
    // is added to prevent accidental reordering or duplication.
    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-row-api-key')).toBeTruthy();
    expect(getByTestId('settings-row-timezone')).toBeTruthy();
    expect(getByTestId('settings-row-logout')).toBeTruthy();
  });
});
