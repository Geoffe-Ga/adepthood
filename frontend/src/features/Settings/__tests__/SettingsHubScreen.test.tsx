/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, ScrollView } from 'react-native';

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

// The operator row asks the server; each test decides what the server says.
// Everything else in the API module stays real.
const mockCapabilities = jest.fn<Promise<{ feedback_triage: boolean }>, []>(() =>
  Promise.reject(new Error('no capability answer configured')),
);

// The Journal group reads the writing-timer link; it answers "no link" here.
const mockUiFlagsGet = jest.fn(() =>
  Promise.resolve({
    has_seen_welcome: true,
    energy_scaffolding_archived: false,
    writing_session_habit_id: null,
  }),
);

// The corpus group gates "Bring in your writing" on the account's vault
// (#3017); each test that cares says what the server answers. The default is a
// vault at an address, so every other suite here renders the hub as before.
const mockVaultConnection = jest.fn<Promise<{ connected: boolean; vault_url: string | null }>, []>(
  () => Promise.resolve({ connected: true, vault_url: 'https://v.example' }),
);

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    adminFeedback: { capabilities: () => mockCapabilities() },
    uiFlags: { get: () => mockUiFlagsGet(), update: jest.fn() },
    vault: { connection: () => mockVaultConnection() },
  };
});

const mockSaveWritingOfferAnswered = jest.fn((_value: boolean) => Promise.resolve());

jest.mock('@/storage/writingOfferStorage', () => ({
  saveWritingOfferAnswered: (value: boolean) => mockSaveWritingOfferAnswered(value),
  loadWritingOfferAnswered: () => Promise.resolve(false),
}));

import { BYOK_HUB_DISCLOSURE } from '../byokDisclosure';
import { LEGAL_DOCUMENTS } from '../legalLinks';
import SettingsHubScreen from '../SettingsHubScreen';

import { ApiError } from '@/api';
import { restoreFeedbackOrigin } from '@/features/Feedback/feedbackFocus';
import {
  SEED_ROW_DESCRIPTION,
  SEED_ROW_LABEL,
  SEED_ROW_VAULT_FIRST_DESCRIPTION,
} from '@/features/Seed/seedCopy';
import { expectNavigationOwnsTitle, watchFocusMoves } from '@/testing/navigationOwnsTitle';

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

  test('summarises both transit boundaries before the API-key screen opens', () => {
    const { getByText } = render(<SettingsHubScreen />);

    expect(getByText(BYOK_HUB_DISCLOSURE)).toBeTruthy();
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

  test('describes deletion without promising that everything is erased everywhere', () => {
    // Backups taken before a deletion still hold a copy until they age out,
    // and the Delete account screen says so (#3057). The row may not promise
    // more than that screen.
    const { getByText, queryByText } = render(<SettingsHubScreen />);

    expect(getByText('Erase your account from Adepthood. This cannot be undone.')).toBeTruthy();
    expect(queryByText(/everything in it/)).toBeNull();
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
// Vault row, first in the Your corpus group (#3007, reordered by #3017)
// ---------------------------------------------------------------------------

describe('SettingsHubScreen — vault row', () => {
  // Literals mirror the deck pinned verbatim in vaultCopy.test.ts. Kept literal
  // so a break in the copy module cannot take this file's other suites with it.
  const VAULT_ROW_LABEL = 'Where your writing lives';
  const VAULT_ROW_DESCRIPTION =
    'An optional copy of what you write, kept in a vault Adepthood manages or one you run. Saying yes to sorting your writing by Aspect is a separate choice, and the app is complete without either.';

  test('renders the vault row first in the Your corpus group, before the way in', () => {
    const { getByTestId } = render(<SettingsHubScreen />);
    const corpus = getByTestId('settings-group-corpus');
    const privacy = getByTestId('settings-group-privacy');

    expect(within(corpus).getByTestId('settings-row-vault')).toBeTruthy();
    expect(
      within(privacy).queryByTestId('settings-row-vault', { includeHiddenElements: true }),
    ).toBeNull();

    const rowIds = within(corpus)
      .getAllByTestId(/^settings-row-/u)
      .map((node) => node.props.testID as string);
    // A corpus lives in a vault (#3015), so the place it lives comes before
    // the way writing comes in, and the decision about sorting comes last.
    expect(rowIds).toEqual([
      'settings-row-vault',
      'settings-row-seed-corpus',
      'settings-row-corpus-consent',
    ]);
  });

  test('the row names no product, only the place', () => {
    const { getByTestId } = render(<SettingsHubScreen />);
    const row = getByTestId('settings-row-vault');

    expect(row.props.accessibilityLabel).not.toMatch(/creek/iu);
    expect(row.props.accessibilityHint).not.toMatch(/creek/iu);
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
// Journal section (#2861) — the writing timer's habit, and the offer again
// ---------------------------------------------------------------------------

describe('SettingsHubScreen — Journal section', () => {
  test('renders the Journal group with the writing-timer row and the offer-again row', async () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-journal')).toBeTruthy();
    await waitFor(() =>
      expect(getByTestId('settings-row-writing-habit').props.accessibilityLabel).toBe(
        'Writing timer → not linked',
      ),
    );
    expect(getByTestId('settings-row-writing-offer-again').props.accessibilityLabel).toBe(
      'Offer again at the end of a session',
    );
  });

  test('offering again clears this device’s answer', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-writing-offer-again'));

    expect(mockSaveWritingOfferAnswered).toHaveBeenCalledWith(false);
  });

  test('sits after the depths group, so the depth choices still lead', () => {
    const { toJSON } = render(<SettingsHubScreen />);
    const tree = JSON.stringify(toJSON());

    expect(tree.indexOf('settings-group-depths')).toBeGreaterThan(-1);
    expect(tree.indexOf('settings-group-journal')).toBeGreaterThan(
      tree.indexOf('settings-group-depths'),
    );
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

  test('with a vault at an address, opens the corpus screen with the ordinary words', async () => {
    const { getByTestId, getByText } = render(<SettingsHubScreen />);
    await waitFor(() => expect(mockVaultConnection).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.press(getByTestId('settings-row-seed-corpus'));

    expect(getByText(SEED_ROW_DESCRIPTION)).toBeTruthy();
    expect(mockNavigate).toHaveBeenCalledWith('SeedCorpus');
  });

  test('when the vault read fails, still opens the corpus screen: unknown is not none', async () => {
    mockVaultConnection.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    const { getByTestId, getByText } = render(<SettingsHubScreen />);
    await waitFor(() => expect(mockVaultConnection).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.press(getByTestId('settings-row-seed-corpus'));

    expect(getByText(SEED_ROW_DESCRIPTION)).toBeTruthy();
    expect(mockNavigate).toHaveBeenCalledWith('SeedCorpus');
  });

  test('while the vault read is still out, opens the corpus screen rather than waiting', () => {
    mockVaultConnection.mockImplementationOnce(() => new Promise(() => undefined));
    const { getByTestId, getByText } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-seed-corpus'));

    expect(getByText(SEED_ROW_DESCRIPTION)).toBeTruthy();
    expect(mockNavigate).toHaveBeenCalledWith('SeedCorpus');
  });

  test('with nothing attached, invites the account to give its corpus a place first', async () => {
    mockVaultConnection.mockImplementationOnce(() =>
      Promise.resolve({ connected: false, vault_url: null }),
    );
    const { getByTestId } = render(<SettingsHubScreen />);
    const row = getByTestId('settings-row-seed-corpus');
    await waitFor(() =>
      expect(getByTestId('settings-row-seed-corpus').props.accessibilityHint).toBe(
        SEED_ROW_VAULT_FIRST_DESCRIPTION,
      ),
    );

    fireEvent.press(getByTestId('settings-row-seed-corpus'));

    // Never hidden and never disabled: the same row, named the same way, that
    // now opens where a corpus lives instead of a picker with nowhere to send.
    expect(row.props.accessibilityLabel).toBe(SEED_ROW_LABEL);
    expect(getByTestId('settings-row-seed-corpus').props.accessibilityRole).toBe('button');
    expect(getByTestId('settings-row-seed-corpus').props.accessibilityState?.disabled).not.toBe(
      true,
    );
    expect(mockNavigate).toHaveBeenCalledWith('VaultSettings');
    expect(mockNavigate).not.toHaveBeenCalledWith('SeedCorpus');
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
  /** Habits, Practices and Course: depths whose destinations ship in every build. */
  const ALWAYS_OFFERED_SWITCHES = 3;
  /** Those three plus the Sangha, once its door exists. */
  const ALL_SWITCHES = ALWAYS_OFFERED_SWITCHES + 1;

  afterEach(() => {
    mockSanghaInviteUrl = '';
  });

  test('says nothing about the Sangha when no invite is configured', () => {
    // The default for this file: an unconfigured build must never ship a row
    // that opens nothing.
    const { queryByTestId } = render(<SettingsHubScreen />);

    expect(queryByTestId('settings-group-sangha')).toBeNull();
  });

  test('offers no Sangha switch either when no invite is configured', () => {
    // A switch with no door behind it would persist a choice that changes
    // nothing visible, so Choose-your-depths reads the same gate as the door.
    const { getByTestId, queryByTestId } = render(<SettingsHubScreen />);

    expect(queryByTestId('depth-toggle-sangha')).toBeNull();
    expect(within(getByTestId('settings-group-depths')).getAllByRole('switch')).toHaveLength(
      ALWAYS_OFFERED_SWITCHES,
    );
  });

  test('mounts the section once an invite is configured', () => {
    mockSanghaInviteUrl = SANGHA_URL;

    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-sangha')).toBeTruthy();
  });

  test('never shows the door without the switch that closes it', () => {
    // SANGHA_DECLINE_HINT points at the Sangha switch; that sentence is only
    // truthful if the switch is in the same tree whenever the door is.
    mockSanghaInviteUrl = SANGHA_URL;

    const { getByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-sangha')).toBeTruthy();
    expect(getByTestId('depth-toggle-sangha')).toBeTruthy();
    expect(within(getByTestId('settings-group-depths')).getAllByRole('switch')).toHaveLength(
      ALL_SWITCHES,
    );
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

describe('SettingsHubScreen — Send feedback (#2898)', () => {
  test('the row opens the same composer route, carrying only the settings-row token', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    const row = getByTestId('settings-row-feedback');
    expect(row.props.accessibilityLabel).toBe('Send feedback');
    fireEvent.press(row);

    expect(mockNavigate).toHaveBeenCalledWith('Feedback', {
      control: 'settings.row.send_feedback',
    });
  });
});

describe('SettingsHubScreen — focus comes back to the row (#2898 review [13])', () => {
  test('the Send feedback row is remembered as the place to return focus to', () => {
    const focus = jest
      .spyOn(AccessibilityInfo, 'sendAccessibilityEvent')
      .mockImplementation(() => undefined);
    const { getByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(getByTestId('settings-row-feedback'));
    // What the composer does when it closes.
    restoreFeedbackOrigin();

    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith(expect.anything(), 'focus');
    focus.mockRestore();
  });
});

describe('SettingsHubScreen — the operator inbox entry', () => {
  const HTTP_FORBIDDEN = 403;
  const ROW = 'settings-row-feedback-inbox';

  test('shows the inbox row for a server-confirmed operator and opens the inbox', async () => {
    mockCapabilities.mockResolvedValueOnce({ feedback_triage: true });
    const { findByTestId } = render(<SettingsHubScreen />);

    fireEvent.press(await findByTestId(ROW));

    expect(mockNavigate).toHaveBeenCalledWith('AdminFeedback');
  });

  test('has no inbox row when the server refuses the capability', async () => {
    mockCapabilities.mockRejectedValueOnce(new ApiError(HTTP_FORBIDDEN, 'admin_required'));
    const { queryByTestId } = render(<SettingsHubScreen />);

    await waitFor(() => expect(mockCapabilities).toHaveBeenCalled());
    expect(queryByTestId(ROW)).toBeNull();
  });
});

describe('SettingsHubScreen — navigation owns the title (#2962)', () => {
  test('paints no "Settings" title, keeps one header named by it, and moves no focus', async () => {
    const focus = watchFocusMoves();
    const screen = render(<SettingsHubScreen />);
    await waitFor(() => expect(mockCapabilities).toHaveBeenCalled());
    expectNavigationOwnsTitle(screen, 'Settings');
    expect(screen.getByText('YOUR ACCOUNT')).toBeTruthy();
    expect(screen.getByText('Manage how Adepthood works for you.')).toBeTruthy();
    expect(screen.getByTestId('settings-row-support')).toBeTruthy();
    focus.expectNone();
  });
});

describe('SettingsHubScreen — opened on the writing-habit row (#3006)', () => {
  const FOCUSED_ROUTE = {
    key: 'settings',
    name: 'Settings' as const,
    params: { focus: 'writing-habit' as const },
  };
  const JOURNAL_Y = 1200;
  const layoutAt = (y: number) => ({
    nativeEvent: { layout: { x: 0, y, width: 320, height: 400 } },
  });

  let scrollTo: jest.SpyInstance;

  beforeEach(() => {
    scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => undefined);
  });

  afterEach(() => {
    scrollTo.mockRestore();
  });

  test('opens the writing-habit picker in place and brings the Journal group into view', async () => {
    const { getByTestId } = render(<SettingsHubScreen route={FOCUSED_ROUTE} />);

    const journal = getByTestId('settings-group-journal');
    expect(within(journal).getByTestId('settings-row-writing-habit')).toBeTruthy();
    expect(within(journal).getByTestId('writing-habit-picker')).toBeTruthy();

    fireEvent(getByTestId('settings-journal-anchor'), 'layout', layoutAt(JOURNAL_Y));

    // Once the reduce-motion setting has been read, the scroll happens, once.
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0]?.[0]).toMatchObject({ y: JOURNAL_Y });
  });

  test('without the focus, the picker starts closed and nothing scrolls', async () => {
    const { getByTestId, queryByTestId } = render(<SettingsHubScreen />);

    fireEvent(getByTestId('settings-journal-anchor'), 'layout', layoutAt(JOURNAL_Y));

    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('writing-habit-picker')).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
