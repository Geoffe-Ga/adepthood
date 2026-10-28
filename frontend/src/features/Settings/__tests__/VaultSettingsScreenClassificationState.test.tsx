/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import VaultSettingsScreen from '../VaultSettingsScreen';

import { vault, vaultActivation, type VaultConnection } from '@/api';
import { settle } from '@/testing/asyncSettle';

/**
 * Whether the vault's sorting is finished, said on the vault it is about (#3577).
 *
 * The sentence is the server's: the screen renders `classification_message`
 * verbatim and writes none of its own, so a rules-only or partial sort reads as
 * "not finished" in exactly the words the server chose. A finished sort, or no
 * sort yet, renders nothing at all -- no badge, no count, no button.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    vault: {
      connection: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
      agents: jest.fn(() => Promise.resolve([])),
      agentActivity: jest.fn(() => Promise.resolve({ status: 'ok', rows: [] })),
      revokeAgent: jest.fn(),
    },
    vaultActivation: { status: jest.fn() },
  };
});

const mockConnection = vault.connection as jest.MockedFunction<typeof vault.connection>;
const mockConnect = vault.connect as jest.MockedFunction<typeof vault.connect>;
const mockDisconnect = vault.disconnect as jest.MockedFunction<typeof vault.disconnect>;
const mockActivationStatus = vaultActivation.status as jest.MockedFunction<
  typeof vaultActivation.status
>;

const VAULT_URL = 'https://vault.example';
const ROUGH_SORT =
  'Some of your writing has only had a rough sort so far. A fuller sort has not finished yet. ' +
  'Nothing is waiting on you.';
const TEST_ID = 'vault-classification-state';
const HIDDEN_TOO = { includeHiddenElements: true } as const;

const INCOMPLETE: VaultConnection = {
  connected: true,
  vault_url: VAULT_URL,
  mcp_address: null,
  classification_state: 'incomplete',
  classification_message: ROUGH_SORT,
};

async function renderVault(connection: VaultConnection) {
  mockConnection.mockResolvedValue(connection);
  const view = render(<VaultSettingsScreen />);
  await settle();
  expect(view.queryByTestId('vault-loading', HIDDEN_TOO)).toBeNull();
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  // The managed offer is not what these tests are about: leave it unanswered.
  mockActivationStatus.mockReturnValue(new Promise(() => undefined));
  mockDisconnect.mockResolvedValue(undefined);
});

describe('VaultSettingsScreen — whether the sort is finished', () => {
  test("says the server's sentence on the connected card when the sort is not finished", async () => {
    const view = await renderVault(INCOMPLETE);

    const card = view.getByTestId('vault-connected-card');
    expect(within(card).getByTestId(TEST_ID)).toHaveTextContent(ROUGH_SORT);
    expect(view.getAllByTestId(TEST_ID, HIDDEN_TOO)).toHaveLength(1);
  });

  test.each([
    ['complete', { classification_state: 'complete', classification_message: null }],
    ['not_run', { classification_state: 'not_run', classification_message: null }],
    ['an older server', {}],
  ] as const)('renders nothing for %s', async (_label, fields) => {
    const view = await renderVault({
      connected: true,
      vault_url: VAULT_URL,
      mcp_address: null,
      ...fields,
    });

    expect(view.getByTestId('vault-connected-card')).toBeTruthy();
    expect(view.queryByTestId(TEST_ID, HIDDEN_TOO)).toBeNull();
  });

  test('says it beside a managed vault too, which has no card', async () => {
    const view = await renderVault({ ...INCOMPLETE, vault_url: null });

    expect(view.getByTestId(TEST_ID)).toHaveTextContent(ROUGH_SORT);
    expect(view.getAllByTestId(TEST_ID, HIDDEN_TOO)).toHaveLength(1);
  });

  test('says nothing for an account the server reads as having no vault', async () => {
    // The deployment-wide vault's owner reads `connected: false` with a state;
    // beside "no vault connected" a sort sentence would contradict the screen.
    const view = await renderVault({ ...INCOMPLETE, connected: false, vault_url: null });

    expect(view.getByTestId('vault-none-connected')).toBeTruthy();
    expect(view.queryByTestId(TEST_ID, HIDDEN_TOO)).toBeNull();
  });

  test('takes the sentence from the reply to a connect, and drops it on disconnect', async () => {
    mockConnect.mockResolvedValue(INCOMPLETE);
    const view = await renderVault({ connected: false, vault_url: null, mcp_address: null });
    fireEvent.press(view.getByTestId('vault-advanced-toggle'));
    fireEvent.changeText(view.getByTestId('vault-address-input'), VAULT_URL);
    fireEvent.changeText(view.getByTestId('vault-key-input'), 'typed-key');
    fireEvent.press(view.getByTestId('connect-vault-button'));
    await waitFor(() => expect(view.getByTestId(TEST_ID)).toHaveTextContent(ROUGH_SORT));

    await act(async () => {
      fireEvent.press(view.getByTestId('disconnect-vault-button'));
    });
    await act(async () => {
      fireEvent.press(view.getByTestId('vault-confirm-confirm'));
    });
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.queryByTestId(TEST_ID, HIDDEN_TOO)).toBeNull());
  });
});
