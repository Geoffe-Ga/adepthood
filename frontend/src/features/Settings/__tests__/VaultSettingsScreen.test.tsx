/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';
import { render, within } from '@testing-library/react-native';
import React from 'react';

import {
  VAULT_EYEBROW,
  VAULT_FLOOR,
  VAULT_INTIMATE,
  VAULT_PROMISE,
  VAULT_SETUP,
  VAULT_TITLE,
  VAULT_WHAT_IT_IS,
} from '../vaultCopy';
import VaultSettingsScreen from '../VaultSettingsScreen';

/**
 * The private-vault screen is informational and nothing else: it states one
 * promise, explains what a vault is, and says the app is complete without one.
 * It carries no connect button, no credential field, no source picker and no
 * connection-state claim, because none of those have a backend to stand on.
 */

// Copy blocks paired with the testID the screen renders them in.
const COPY_BLOCKS: [string, string][] = [
  ['vault-promise', VAULT_PROMISE],
  ['vault-what-it-is', VAULT_WHAT_IT_IS],
  ['vault-floor', VAULT_FLOOR],
  ['vault-intimate', VAULT_INTIMATE],
  ['vault-setup', VAULT_SETUP],
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — rendering', () => {
  // No providers, no store, no network: the screen depends on nothing a vault
  // would supply, so it renders bare.
  it('renders the screen scaffold', () => {
    const { getByTestId } = render(<VaultSettingsScreen />);
    expect(getByTestId('vault-settings-screen')).toBeTruthy();
  });

  it('renders the eyebrow marking the vault optional', () => {
    const { getByText } = render(<VaultSettingsScreen />);
    // The shared header upper-cases the eyebrow, so match without case.
    expect(getByText(new RegExp(`^${VAULT_EYEBROW}$`, 'iu'))).toBeTruthy();
  });

  it('renders the title with accessibilityRole="header"', () => {
    const { getByText } = render(<VaultSettingsScreen />);
    expect(getByText(VAULT_TITLE).props.accessibilityRole).toBe('header');
  });

  for (const [testID, copy] of COPY_BLOCKS) {
    it(`renders "${testID}" carrying its copy verbatim`, () => {
      const { getByTestId } = render(<VaultSettingsScreen />);
      expect(within(getByTestId(testID)).getByText(copy)).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — accessibility', () => {
  it('gives the floor block accessibilityRole="text"', () => {
    const { getByTestId } = render(<VaultSettingsScreen />);
    expect(getByTestId('vault-floor').props.accessibilityRole).toBe('text');
  });

  it('does not re-announce the promise on the floor block', () => {
    // The header already reads the promise; an explicit label repeating it here
    // would announce the same sentence twice in reading order.
    const { getByTestId } = render(<VaultSettingsScreen />);

    expect(getByTestId('vault-floor').props.accessibilityLabel).toBeUndefined();
  });

  it('states its own optionality, so the floor stands alone when focused', () => {
    const { getByTestId } = render(<VaultSettingsScreen />);

    expect(getByTestId('vault-floor')).toHaveTextContent(/complete without a vault/iu);
  });
});

// ---------------------------------------------------------------------------
// Absent affordances — the screen is informational only
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — no connect affordance', () => {
  it('offers no "connect a vault" wording', () => {
    const { queryByText } = render(<VaultSettingsScreen />);
    expect(queryByText(/connect (your|a) vault/iu)).toBeNull();
  });

  it('exposes no button at all', () => {
    // A vault is configured where it runs, so there is nothing to press here.
    const { queryAllByRole } = render(<VaultSettingsScreen />);
    expect(queryAllByRole('button')).toHaveLength(0);
  });
});

describe('VaultSettingsScreen — no credential input', () => {
  it('renders no text field of any kind', () => {
    const { queryByPlaceholderText } = render(<VaultSettingsScreen />);
    expect(queryByPlaceholderText(/.*/u)).toBeNull();
  });
});

describe('VaultSettingsScreen — no source picker', () => {
  it('names no ingestion source', () => {
    const { queryByText } = render(<VaultSettingsScreen />);
    expect(queryByText(/discord|google drive|claude conversations|recordings/iu)).toBeNull();
  });
});

describe('VaultSettingsScreen — no connection-state claim', () => {
  // There is no vault status endpoint, so any state claim would be false on
  // some deployment. The screen must state none.
  it('claims no connected, disconnected, or status state', () => {
    const { queryByText } = render(<VaultSettingsScreen />);
    expect(queryByText(/\b(not connected|disconnected|connection status|status)\b/iu)).toBeNull();
  });

  it('mentions "connected" only in the conditional explanation', () => {
    const { queryAllByText } = render(<VaultSettingsScreen />);

    // The single mention is the "when one is connected" clause, never a claim
    // about this install.
    expect(queryAllByText(/\bconnected\b/iu)).toHaveLength(1);
    expect(queryAllByText(/when one is connected/iu)).toHaveLength(1);
  });
});
