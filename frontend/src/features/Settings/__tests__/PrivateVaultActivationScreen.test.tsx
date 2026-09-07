/* global describe, it, expect, beforeEach, jest */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { prepareKeyCeremony } from '../keyCeremony';
import PrivateVaultActivationScreen, {
  recoveryAcknowledgementA11y,
} from '../PrivateVaultActivationScreen';
import { copyRecoveryKey, saveRecoveryKeyLocally } from '../saveRecoveryKey';

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
      keyCeremony: jest.fn(),
      completeCeremony: jest.fn(),
    },
  };
});

jest.mock('../keyCeremony', () => ({ prepareKeyCeremony: jest.fn() }));
jest.mock('../saveRecoveryKey', () => ({
  copyRecoveryKey: jest.fn(),
  saveRecoveryKeyLocally: jest.fn(),
}));

const mockStatus = vaultActivation.status as jest.MockedFunction<typeof vaultActivation.status>;
const mockActivate = vaultActivation.activate as jest.MockedFunction<
  typeof vaultActivation.activate
>;
const mockRetry = vaultActivation.retry as jest.MockedFunction<typeof vaultActivation.retry>;
const mockChallenge = vaultActivation.keyCeremony as jest.MockedFunction<
  typeof vaultActivation.keyCeremony
>;
const mockComplete = vaultActivation.completeCeremony as jest.MockedFunction<
  typeof vaultActivation.completeCeremony
>;
const mockPrepare = prepareKeyCeremony as jest.MockedFunction<typeof prepareKeyCeremony>;
const mockCopy = copyRecoveryKey as jest.MockedFunction<typeof copyRecoveryKey>;
const mockSave = saveRecoveryKeyLocally as jest.MockedFunction<typeof saveRecoveryKeyLocally>;

const INACTIVE: VaultActivation = {
  active: false,
  state: 'inactive',
  retryable: false,
  failure_reason: null,
  credential_received: false,
  attested_confidential: null,
};
const AWAITING: VaultActivation = {
  ...INACTIVE,
  active: true,
  state: 'awaiting_key_ceremony',
};
const PROVISIONING: VaultActivation = { ...AWAITING, state: 'provisioning' };
const READY: VaultActivation = {
  ...AWAITING,
  state: 'ready',
  credential_received: true,
  attested_confidential: false,
};
const CHALLENGE = {
  protocol_version: '1.0.0' as const,
  job_id: 'job-1',
  activation_id: 'activation-1',
  ceremony_id: 'ceremony-1',
  server_nonce: 'A'.repeat(43),
  expires_at: '2026-09-08T12:00:00Z',
};
const ARTIFACT = {
  version: 2 as const,
  kdf: {
    algorithm: 'argon2id' as const,
    salt: 'a'.repeat(32),
    time_cost: 3 as const,
    lanes: 4 as const,
    memory_kib: 65_536 as const,
  },
  passphrase_wrapped: { nonce: 'b'.repeat(24), ciphertext: 'c'.repeat(96) },
  recovery_wrapped: { nonce: 'd'.repeat(24), ciphertext: 'e'.repeat(96) },
  binding: {
    protocol_version: '1.0.0' as const,
    activation_id: CHALLENGE.activation_id,
    ceremony_id: CHALLENGE.ceremony_id,
    server_nonce: CHALLENGE.server_nonce,
    client_nonce: 'F'.repeat(43),
  },
};
const RECOVERY = 'AEAQC-AIBAE-AQCAI-BAEAQ-CAIBA-EAQCA-IBAEA-QCAIB-AEAQC-AIBAE-AQ';

const navigation = { goBack: jest.fn() };

async function renderActivation(status: VaultActivation = INACTIVE) {
  mockStatus.mockResolvedValue(status);
  const view = render(<PrivateVaultActivationScreen navigation={navigation} />);
  await waitFor(() => expect(view.queryByTestId('activation-loading')).toBeNull());
  return view;
}

async function prepareRecovery(view: Awaited<ReturnType<typeof renderActivation>>) {
  fireEvent.changeText(view.getByTestId('vault-passphrase-input'), 'long private passphrase');
  fireEvent.changeText(
    view.getByTestId('vault-passphrase-confirm-input'),
    'long private passphrase',
  );
  await act(async () => fireEvent.press(view.getByTestId('prepare-vault-recovery')));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCopy.mockResolvedValue(true);
  mockSave.mockResolvedValue(true);
  mockChallenge.mockResolvedValue(CHALLENGE);
  mockPrepare.mockResolvedValue({ recoveryCode: RECOVERY, wrappedArtifact: ARTIFACT });
  mockActivate.mockResolvedValue(PROVISIONING);
  mockRetry.mockResolvedValue(PROVISIONING);
  mockComplete.mockResolvedValue({ ...AWAITING, state: 'awaiting_handoff' });
});

describe('private vault activation choice', () => {
  it('opens with an optional, honest explanation and no secret controls', async () => {
    const view = await renderActivation();

    expect(view.getByText('Adepthood is complete without a private vault.')).toBeTruthy();
    expect(
      view.getByText(
        /Intimate processing stays unavailable until confidential compute is verified/u,
      ),
    ).toBeTruthy();
    expect(view.queryByTestId('vault-passphrase-input')).toBeNull();
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it('returns to settings without allocating when declined', async () => {
    const view = await renderActivation();

    fireEvent.press(view.getByTestId('cancel-vault-activation'));

    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it('allocates only after the irreversible warning and explicit action', async () => {
    const view = await renderActivation();

    fireEvent.press(view.getByTestId('continue-vault-activation'));
    expect(view.getByText(/If both are lost, nobody can recover this vault/u)).toBeTruthy();
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

describe('client-held key ceremony', () => {
  it('requires matching passphrases before requesting a challenge', async () => {
    const view = await renderActivation(AWAITING);
    fireEvent.changeText(view.getByTestId('vault-passphrase-input'), 'one passphrase');
    fireEvent.changeText(view.getByTestId('vault-passphrase-confirm-input'), 'different one');

    fireEvent.press(view.getByTestId('prepare-vault-recovery'));

    expect(view.getByText('Those passphrases do not match.')).toBeTruthy();
    expect(mockChallenge).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('derives locally, clears the inputs, and shows recovery exactly once', async () => {
    const view = await renderActivation(AWAITING);

    await prepareRecovery(view);

    expect(mockPrepare).toHaveBeenCalledWith(CHALLENGE, 'long private passphrase');
    expect(view.queryByTestId('vault-passphrase-input')).toBeNull();
    expect(view.getByTestId('vault-recovery-code').props.children).toBe(RECOVERY);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('labels both secret controls and exposes recovery acknowledgement as a checkbox', async () => {
    const view = await renderActivation(AWAITING);

    expect(view.getByLabelText('Private vault passphrase').props.secureTextEntry).toBe(true);
    expect(view.getByLabelText('Confirm private vault passphrase').props.secureTextEntry).toBe(
      true,
    );
    await prepareRecovery(view);
    const acknowledgement = view.getByLabelText('I stored my recovery key somewhere safe');
    expect(acknowledgement.props.accessibilityRole).toBe('checkbox');
    expect(acknowledgement.props.accessibilityState).toEqual({ checked: false });
    expect(recoveryAcknowledgementA11y(false)['aria-checked']).toBe(false);

    fireEvent.press(acknowledgement);

    expect(
      view.getByLabelText('I stored my recovery key somewhere safe').props.accessibilityState,
    ).toEqual({ checked: true });
    expect(recoveryAcknowledgementA11y(true)['aria-checked']).toBe(true);
    expect(view.getByTestId('complete-vault-ceremony').props.accessibilityState.disabled).toBe(
      false,
    );
  });

  it('copies and saves only on deliberate recovery actions', async () => {
    const view = await renderActivation(AWAITING);
    await prepareRecovery(view);

    await act(async () => fireEvent.press(view.getByTestId('copy-vault-recovery')));
    await act(async () => fireEvent.press(view.getByTestId('save-vault-recovery')));

    expect(mockCopy).toHaveBeenCalledWith(RECOVERY);
    expect(mockSave).toHaveBeenCalledWith(RECOVERY);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('will not submit until the user confirms a recovery copy is stored', async () => {
    const view = await renderActivation(AWAITING);
    await prepareRecovery(view);

    expect(view.getByTestId('complete-vault-ceremony').props.accessibilityState.disabled).toBe(
      true,
    );
    fireEvent.press(view.getByTestId('vault-recovery-saved'));
    await act(async () => fireEvent.press(view.getByTestId('complete-vault-ceremony')));

    expect(mockComplete).toHaveBeenCalledWith({
      protocol_version: '1.0.0',
      ceremony_id: CHALLENGE.ceremony_id,
      server_nonce: CHALLENGE.server_nonce,
      recovery_saved: true,
      wrapped_artifact: ARTIFACT,
      attestation: null,
      key_release: null,
    });
    expect(view.queryByText(RECOVERY)).toBeNull();
  });

  it('forgets an unsubmitted recovery copy when the screen leaves', async () => {
    const first = await renderActivation(AWAITING);
    await prepareRecovery(first);
    expect(first.getByText(RECOVERY)).toBeTruthy();
    first.unmount();

    const second = await renderActivation(AWAITING);
    expect(second.queryByText(RECOVERY)).toBeNull();
    expect(second.getByTestId('vault-passphrase-input')).toBeTruthy();
  });
});

describe('resumable progress and honest capability', () => {
  it('restores server progress without restoring any secret', async () => {
    const view = await renderActivation(PROVISIONING);

    expect(view.getByTestId('activation-progress')).toBeTruthy();
    expect(view.queryByTestId('vault-passphrase-input')).toBeNull();
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

  it('does not claim Intimate processing when confidential compute is unverified', async () => {
    const view = await renderActivation(READY);

    expect(view.getByText('Your private vault is ready.')).toBeTruthy();
    expect(view.getByText(/Intimate processing remains unavailable/u)).toBeTruthy();
  });

  it('shows Intimate capability only when the backend verified it', async () => {
    const view = await renderActivation({ ...READY, attested_confidential: true });

    expect(view.getByText('Intimate processing is available.')).toBeTruthy();
  });

  it('keeps a failed status read from blocking the journal', async () => {
    mockStatus.mockRejectedValue(new Error('offline'));
    const view = render(<PrivateVaultActivationScreen navigation={navigation} />);

    await waitFor(() => expect(view.getByTestId('activation-load-error')).toBeTruthy());
    expect(view.getByText(/Your journal still works/u)).toBeTruthy();
  });
});
