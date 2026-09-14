/* global describe, it, expect, beforeEach, jest */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import PrivateVaultActivationScreen from '../PrivateVaultActivationScreen';

import { vaultActivation, type VaultActivation } from '@/api';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    vaultActivation: {
      status: jest.fn(),
      activate: jest.fn(),
      retry: jest.fn(),
    },
  };
});

const mockStatus = vaultActivation.status as jest.MockedFunction<typeof vaultActivation.status>;
const mockActivate = vaultActivation.activate as jest.MockedFunction<
  typeof vaultActivation.activate
>;
const mockRetry = vaultActivation.retry as jest.MockedFunction<typeof vaultActivation.retry>;

const INACTIVE: VaultActivation = {
  active: false,
  state: 'inactive',
  new_activation_available: true,
  retryable: false,
  failure_reason: null,
  credential_received: false,
  attested_confidential: null,
  custody_mode: null,
};
const PROVISIONING: VaultActivation = {
  ...INACTIVE,
  active: true,
  state: 'provisioning',
};
const READY: VaultActivation = {
  ...PROVISIONING,
  state: 'ready',
  credential_received: true,
  attested_confidential: false,
  custody_mode: 'provider_managed',
};
const navigation = { goBack: jest.fn() };

async function renderActivation(status: VaultActivation = INACTIVE) {
  mockStatus.mockResolvedValue(status);
  const view = render(<PrivateVaultActivationScreen navigation={navigation} />);
  await waitFor(() => expect(view.queryByTestId('activation-loading')).toBeNull());
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActivate.mockResolvedValue(PROVISIONING);
  mockRetry.mockResolvedValue(PROVISIONING);
});

describe('provider-managed vault activation choice', () => {
  it('renders an honest low-friction unavailable state with no activation control', async () => {
    const view = await renderActivation({ ...INACTIVE, new_activation_available: false });

    expect(view.getByTestId('managed-vault-unavailable')).toBeTruthy();
    expect(view.getByText(/not available for this account yet/u)).toBeTruthy();
    expect(view.getByText(/journal is complete without it/u)).toBeTruthy();
    expect(view.queryByTestId('continue-vault-activation')).toBeNull();
    expect(view.queryByTestId('activate-private-vault')).toBeNull();
  });

  it('opens with the cross-platform custody boundary and no ceremony controls', async () => {
    const view = await renderActivation();

    expect(view.getByText(/optional storage/iu)).toBeTruthy();
    expect(view.getByText('Adepthood is complete without a managed vault.')).toBeTruthy();
    expect(view.getByText(/encrypted with provider-managed keys/u)).toBeTruthy();
    expect(view.getByText(/operator can access stored bytes/u)).toBeTruthy();
    expect(
      view.getByText(
        /INTIMATE entries stay in Adepthood and are never sent to this managed vault/u,
      ),
    ).toBeTruthy();
    expect(view.queryByTestId('vault-passphrase-input')).toBeNull();
    expect(view.queryByTestId('vault-recovery-once')).toBeNull();
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it('returns to settings without allocating when declined', async () => {
    const view = await renderActivation();

    fireEvent.press(view.getByTestId('cancel-vault-activation'));

    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it('requires an explicit action after explaining unattended restart custody', async () => {
    const view = await renderActivation();

    fireEvent.press(view.getByTestId('continue-vault-activation'));
    expect(
      view.getByText(/Provider-managed keys unlock it after unattended restarts/u),
    ).toBeTruthy();
    expect(view.getByText(/will not ask you to create or store unlock material/u)).toBeTruthy();
    expect(mockActivate).not.toHaveBeenCalled();

    await act(async () => fireEvent.press(view.getByTestId('activate-private-vault')));

    expect(mockActivate).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('activation-progress')).toBeTruthy();
  });

  it('keeps a failed allocation optional and explains that journaling is unaffected', async () => {
    mockActivate.mockRejectedValue(new Error('offline'));
    const view = await renderActivation();
    fireEvent.press(view.getByTestId('continue-vault-activation'));

    await act(async () => fireEvent.press(view.getByTestId('activate-private-vault')));

    expect(view.getByText('We could not start the vault. Your journal still works.')).toBeTruthy();
    expect(view.getByTestId('cancel-vault-activation')).toBeTruthy();
  });
});

describe('resumable progress and honest custody', () => {
  it('restores direct provisioning progress without any ceremony surface', async () => {
    const view = await renderActivation(PROVISIONING);

    expect(view.getByTestId('activation-progress')).toBeTruthy();
    expect(view.queryByTestId('vault-passphrase-input')).toBeNull();
    expect(view.queryByTestId('complete-vault-ceremony')).toBeNull();
    expect(view.getByText(/You can keep journaling while this finishes/u)).toBeTruthy();
  });

  it('offers a retry only for a retryable failure', async () => {
    const failed: VaultActivation = {
      ...PROVISIONING,
      state: 'failed',
      retryable: true,
      failure_reason: 'provider_unavailable',
    };
    const view = await renderActivation(failed);

    await act(async () => fireEvent.press(view.getByTestId('retry-vault-activation')));

    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('activation-progress')).toBeTruthy();
  });

  it('keeps a failed retry honest and available for another attempt', async () => {
    const failed: VaultActivation = {
      ...PROVISIONING,
      state: 'failed',
      retryable: true,
      failure_reason: 'provider_unavailable',
    };
    mockRetry.mockRejectedValue(new Error('still offline'));
    const view = await renderActivation(failed);

    await act(async () => fireEvent.press(view.getByTestId('retry-vault-activation')));

    expect(view.getByText('The retry did not reach Creek. Try again when ready.')).toBeTruthy();
    expect(view.getByTestId('retry-vault-activation')).toBeTruthy();
  });

  it('renders explicit provider-managed truth at readiness', async () => {
    const view = await renderActivation(READY);

    expect(view.getByText('Your managed vault is ready.')).toBeTruthy();
    expect(view.getByText(/encrypted with provider-managed keys/u)).toBeTruthy();
    expect(view.getByText(/operator can access stored bytes/u)).toBeTruthy();
    expect(view.getByText(/not confidential compute/u)).toBeTruthy();
    expect(
      view.getByText(/INTIMATE entries remain in Adepthood and are skipped by the managed vault/u),
    ).toBeTruthy();
  });

  it('does not reinterpret a retired wrapped artifact as user-held custody', async () => {
    const view = await renderActivation({ ...READY, custody_mode: 'wrapped_artifact_only' });

    expect(view.getByText(/old wrapped artifact never controlled Fly storage/u)).toBeTruthy();
    expect(view.getByText(/no user-held recovery claim applies/u)).toBeTruthy();
  });

  it('keeps a failed status read from blocking the journal', async () => {
    mockStatus.mockRejectedValue(new Error('offline'));
    const view = render(<PrivateVaultActivationScreen navigation={navigation} />);

    await waitFor(() => expect(view.getByTestId('activation-load-error')).toBeTruthy());
    expect(view.getByText(/Your journal still works/u)).toBeTruthy();
  });
});
