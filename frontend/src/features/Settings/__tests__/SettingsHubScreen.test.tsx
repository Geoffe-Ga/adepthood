/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

const mockNavigate = jest.fn();
const mockLogout = jest.fn(() => Promise.resolve());

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ logout: mockLogout, token: 'hub-test-token' }),
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

// ---------------------------------------------------------------------------
// Issue #897 — Privacy section in Settings (RED — fails until impl exists)
// ---------------------------------------------------------------------------

describe('SettingsHubScreen — Privacy section (issue #897)', () => {
  test('renders the Privacy group and statement block', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-privacy')).toBeTruthy();
    expect(getByTestId('settings-privacy-statement')).toBeTruthy();
  });

  test('statement block is contained within the Privacy group', () => {
    const { getByTestId } = render(<SettingsHubScreen />);
    const group = getByTestId('settings-group-privacy');

    expect(within(group).getByTestId('settings-privacy-statement')).toBeTruthy();
  });

  test('renders the entry-visibility privacy statement verbatim', () => {
    const { getByText } = render(<SettingsHubScreen />);

    expect(
      getByText('You choose the privacy of every entry — Public, Personal, or Intimate.'),
    ).toBeTruthy();
  });

  test('renders the Intimate-entries AI statement verbatim', () => {
    const { getByText } = render(<SettingsHubScreen />);

    expect(getByText('Entries you mark Intimate are never sent to any AI.')).toBeTruthy();
  });

  test('statement block carries a non-empty accessibilityLabel and accessibilityRole="text"', () => {
    const { getByTestId } = render(<SettingsHubScreen />);
    const block = getByTestId('settings-privacy-statement');

    expect(typeof block.props.accessibilityLabel).toBe('string');
    expect((block.props.accessibilityLabel as string).length).toBeGreaterThan(0);
    expect(block.props.accessibilityRole).toBe('text');
  });

  test('accessibilityLabel is a full sentence, not a fragment', () => {
    const { getByTestId } = render(<SettingsHubScreen />);
    const block = getByTestId('settings-privacy-statement');
    const label = block.props.accessibilityLabel as string;

    // A complete sentence ends with a full-stop or equivalent punctuation.
    expect(label).toMatch(/[.!?]$/u);
    // Must reference both key concepts so screen-reader users get the full picture.
    expect(label.toLowerCase()).toContain('intimate');
    expect(label.toLowerCase()).toContain('privacy');
  });

  test('NEGATIVE accuracy guard: does not claim "encrypted at rest"', () => {
    const { queryByText } = render(<SettingsHubScreen />);

    expect(queryByText(/encrypted at rest/iu)).toBeNull();
  });

  test('regression: existing sections and rows still render after Privacy addition', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-account')).toBeTruthy();
    expect(getByTestId('settings-row-api-key')).toBeTruthy();
    expect(getByTestId('settings-group-session')).toBeTruthy();
    expect(getByTestId('settings-row-logout')).toBeTruthy();
    expect(getByTestId('settings-group-support')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// "Choose your depths" section in the hub (RED — fails until impl exists)
// ---------------------------------------------------------------------------

describe('SettingsHubScreen — Choose your depths section', () => {
  test('renders the depths section with testID "settings-group-depths"', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    // Fails until ChooseDepthsSection is mounted inside SettingsHubScreen.
    expect(getByTestId('settings-group-depths')).toBeTruthy();
  });

  test('regression: all pre-existing sections and rows still render after depths addition', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-account')).toBeTruthy();
    expect(getByTestId('settings-row-api-key')).toBeTruthy();
    expect(getByTestId('settings-group-session')).toBeTruthy();
    expect(getByTestId('settings-row-logout')).toBeTruthy();
    expect(getByTestId('settings-group-privacy')).toBeTruthy();
    expect(getByTestId('settings-group-support')).toBeTruthy();
  });
});
