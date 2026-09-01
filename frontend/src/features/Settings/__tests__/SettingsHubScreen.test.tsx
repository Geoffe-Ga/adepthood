/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

const mockNavigate = jest.fn();
const mockLogout = jest.fn(() => Promise.resolve());
const mockOpenExternalUrl = jest.fn((_url: string) => Promise.resolve(true));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ logout: mockLogout, token: 'hub-test-token' }),
}));

jest.mock('@/utils/openExternalUrl', () => ({
  openExternalUrl: (url: string) => mockOpenExternalUrl(url),
}));

// The Sangha invite is configuration with no default, so the hub renders no
// Sangha surface unless a test supplies one. Everything else in config is left
// real: the depth-preferences store reaches the API client, which needs it.
let mockSanghaInviteUrl = '';

jest.mock('@/config', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/config');
  // `defineProperty` rather than a `get` in the object literal: Babel's
  // object-spread helper reads a literal getter once while building the
  // object, which would freeze the invite at its value on the first require.
  return Object.defineProperty({ ...actual }, 'SANGHA_INVITE_URL', {
    enumerable: true,
    get: (): string => mockSanghaInviteUrl,
  });
});

import { LEGAL_DOCUMENTS } from '../legalLinks';
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

  test('offers an in-app route to account deletion', () => {
    // App Store Guideline 5.1.1(v): the path must be reachable in the app,
    // not via a support email.
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-delete-account'));

    expect(mockNavigate).toHaveBeenCalledWith('DeleteAccount');
  });

  test('offers an in-app route to a copy of everything the user wrote', () => {
    // The counterpart to deletion, and the reason deletion is a reasonable
    // thing to offer at all: an endpoint no screen reaches is not a feature.
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-export-data'));

    expect(mockNavigate).toHaveBeenCalledWith('ExportData');
  });

  test('exporting is a separate row from deleting', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-export-data'));

    expect(mockNavigate).not.toHaveBeenCalledWith('DeleteAccount');
  });

  test('deleting the account is a separate row from logging out', () => {
    // The two must never be the same tap: one ends a session, the other ends
    // the account.
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-delete-account'));

    expect(mockLogout).not.toHaveBeenCalled();
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
// Private vault row inside the Privacy group
// ---------------------------------------------------------------------------

describe('SettingsHubScreen — private vault row', () => {
  // Literals mirror the deck pinned verbatim in vaultCopy.test.ts. Kept literal
  // so a break in the copy module cannot take this file's other suites with it.
  const VAULT_ROW_LABEL = 'Private vault';
  const VAULT_ROW_DESCRIPTION =
    'An optional copy of what you write, in a space you run yourself. Adepthood is complete without one.';

  test('renders the vault row inside the Privacy group', () => {
    const { getByTestId } = render(<SettingsHubScreen />);
    const group = getByTestId('settings-group-privacy');

    expect(within(group).getByTestId('settings-row-vault')).toBeTruthy();
  });

  test('labels the row with the vault copy', () => {
    const { getByTestId } = render(<SettingsHubScreen />);
    const row = getByTestId('settings-row-vault');

    expect(row.props.accessibilityLabel).toBe(VAULT_ROW_LABEL);
    expect(row.props.accessibilityHint).toBe(VAULT_ROW_DESCRIPTION);
  });

  test('tapping the vault row navigates to VaultSettings', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-vault'));

    expect(mockNavigate).toHaveBeenCalledWith('VaultSettings');
  });

  test('regression: the privacy promise and every existing row still render', () => {
    const { getByTestId, getByText } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-privacy-statement')).toBeTruthy();
    expect(
      getByText('You choose the privacy of every entry — Public, Personal, or Intimate.'),
    ).toBeTruthy();
    expect(getByText('Entries you mark Intimate are never sent to any AI.')).toBeTruthy();
    expect(getByTestId('settings-row-api-key')).toBeTruthy();
    expect(getByTestId('settings-row-timezone')).toBeTruthy();
    expect(getByTestId('settings-row-logout')).toBeTruthy();
    expect(getByTestId('settings-row-support')).toBeTruthy();
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

// ---------------------------------------------------------------------------
// Legal section — the privacy policy and terms must be reachable in the app
// ---------------------------------------------------------------------------

describe('SettingsHubScreen — Legal section', () => {
  test('renders a row for every legal document', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-legal')).toBeTruthy();
    for (const document of LEGAL_DOCUMENTS) {
      expect(within(getByTestId('settings-group-legal')).getByTestId(document.testID)).toBeTruthy();
    }
  });

  test('covers both the privacy policy and the terms of service', () => {
    // App Store Review 5.1.1 wants the policy reachable; the terms are what
    // the account and purchase language rests on. One without the other is
    // the omission this catches.
    expect(LEGAL_DOCUMENTS.map((document) => document.id).sort()).toEqual(['privacy', 'terms']);
  });

  test('tapping a legal row hands its https URL to the platform browser', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    for (const document of LEGAL_DOCUMENTS) {
      fireEvent.press(getByTestId(document.testID));

      expect(mockOpenExternalUrl).toHaveBeenCalledWith(document.url);
      expect(document.url.startsWith('https://')).toBe(true);
    }
  });

  test('a legal row navigates nowhere — the documents are read outside the app', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    for (const document of LEGAL_DOCUMENTS) {
      fireEvent.press(getByTestId(document.testID));
    }

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('regression: every pre-existing group still renders alongside Legal', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-account')).toBeTruthy();
    expect(getByTestId('settings-group-corpus')).toBeTruthy();
    expect(getByTestId('settings-group-privacy')).toBeTruthy();
    expect(getByTestId('settings-group-depths')).toBeTruthy();
    expect(getByTestId('settings-group-session')).toBeTruthy();
    expect(getByTestId('settings-group-support')).toBeTruthy();
  });
});

describe('SettingsHubScreen — the corpus-seeding destination', () => {
  test('offers a way to bring in what was written elsewhere', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-corpus')).toBeTruthy();
    expect(getByTestId('settings-row-seed-corpus')).toBeTruthy();
  });

  test('tapping it opens the corpus screen', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-seed-corpus'));

    expect(mockNavigate).toHaveBeenCalledWith('SeedCorpus');
  });
});

// ---------------------------------------------------------------------------
// The consent decision itself: a live pair of endpoints nothing rendered until
// this row existed, which is how every account's corpus stayed empty.
// ---------------------------------------------------------------------------

describe('SettingsHubScreen — the corpus-consent destination', () => {
  test('offers the decision about what may be sorted into the corpus', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-row-corpus-consent')).toBeTruthy();
  });

  test('tapping it opens the consent screen', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-corpus-consent'));

    expect(mockNavigate).toHaveBeenCalledWith('CorpusConsent');
  });
});

// ---------------------------------------------------------------------------
// The Digital Sangha's front door, mounted in the hub.
// ---------------------------------------------------------------------------

describe('SettingsHubScreen — the Digital Sangha door', () => {
  const SANGHA_URL = 'https://discord.gg/hub-test-sangha';

  afterEach(() => {
    mockSanghaInviteUrl = '';
  });

  test('says nothing about the Sangha when no invite is configured', () => {
    // The default for this file: an unconfigured build must never ship a row
    // that opens nothing.
    const { queryByTestId } = render(<SettingsHubScreen />);

    expect(queryByTestId('settings-group-sangha')).toBeNull();
  });

  test('mounts the section once an invite is configured', () => {
    mockSanghaInviteUrl = SANGHA_URL;

    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-sangha')).toBeTruthy();
  });

  test('hands the invite to the platform browser rather than opening it inside', () => {
    mockSanghaInviteUrl = SANGHA_URL;

    const { getByTestId } = render(<SettingsHubScreen />);
    fireEvent.press(getByTestId('settings-row-sangha-discord'));

    expect(mockOpenExternalUrl).toHaveBeenCalledWith(SANGHA_URL);
  });

  test('navigates nowhere: the door leaves the app instead of embedding it', () => {
    mockSanghaInviteUrl = SANGHA_URL;

    const { getByTestId } = render(<SettingsHubScreen />);
    fireEvent.press(getByTestId('settings-row-sangha-discord'));

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
