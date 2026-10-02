/* global describe, it, expect, beforeEach, jest */
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import PrivateVaultActivationScreen from '../PrivateVaultActivationScreen';
import { HIGHER_SELF_GAIN, VAULT_SORTING_CHOICE, VAULT_TITLE } from '../vaultCopy';

import { vaultActivation, type VaultActivation } from '@/api';
import { settle } from '@/testing/asyncSettle';
import { expectNavigationOwnsTitle, watchFocusMoves } from '@/testing/navigationOwnsTitle';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    vaultActivation: {
      status: jest.fn(),
      activate: jest.fn(),
      retry: jest.fn(),
      recover: jest.fn(),
    },
  };
});

const mockStatus = vaultActivation.status as jest.MockedFunction<typeof vaultActivation.status>;
const mockActivate = vaultActivation.activate as jest.MockedFunction<
  typeof vaultActivation.activate
>;
const mockRetry = vaultActivation.retry as jest.MockedFunction<typeof vaultActivation.retry>;
const mockRecover = vaultActivation.recover as jest.MockedFunction<typeof vaultActivation.recover>;

const INACTIVE: VaultActivation = {
  active: false,
  state: 'inactive',
  new_activation_available: true,
  recovery_available: false,
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
  await settle();
  expect(view.queryByTestId('activation-loading')).toBeNull();
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActivate.mockResolvedValue(PROVISIONING);
  mockRetry.mockResolvedValue(PROVISIONING);
  mockRecover.mockResolvedValue({ ...PROVISIONING, state: 'deleting' });
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

  it('says what saying yes gives, and that a vault is not that yes, before the custody notice (#3003)', async () => {
    const view = await renderActivation();
    const intro = within(view.getByTestId('activation-intro'));
    const order = intro
      .getAllByTestId(/^activation-/u)
      .map((node) => node.props.testID as string)
      .filter((testID) => testID !== 'activation-intro');

    expect(view.getByTestId('activation-higher-self-gain')).toHaveTextContent(HIGHER_SELF_GAIN);
    expect(view.getByTestId('activation-sorting-choice')).toHaveTextContent(VAULT_SORTING_CHOICE);
    expect(order.slice(0, 3)).toEqual([
      'activation-higher-self-gain',
      'activation-sorting-choice',
      'activation-custody-notice',
    ]);
    expect(view.getByText('Adepthood is complete without a managed vault.')).toBeTruthy();
  });

  it('names the settings screen it returns to by the name it now has (#3007)', async () => {
    const view = await renderActivation();

    expect(view.getByTestId('cancel-vault-activation').props.accessibilityLabel).toBe(
      `Not now, return to ${VAULT_TITLE}`,
    );
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

  it('offers confirmed cleanup instead of retry for a terminal failed allocation', async () => {
    const failed: VaultActivation = {
      ...PROVISIONING,
      state: 'failed',
      retryable: false,
      failure_reason: 'provider_rejected',
      recovery_available: true,
    };
    const view = await renderActivation(failed);

    expect(
      view.getByText(/remove the failed allocation before creating a fresh one/u),
    ).toBeTruthy();
    await act(async () => fireEvent.press(view.getByTestId('recover-vault-activation')));

    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(mockRetry).not.toHaveBeenCalled();
    expect(view.getByText(/securely removing the failed allocation/u)).toBeTruthy();
    expect(view.getByText(/may take up to 24 hours/u)).toBeTruthy();
    expect(view.getByText(/leave this page and return later/u)).toBeTruthy();
    expect(view.getByText(/journal remains available/u)).toBeTruthy();
  });

  it('gives a safe next step when Creek refuses cleanup permanently', async () => {
    const failed: VaultActivation = {
      ...PROVISIONING,
      state: 'failed',
      retryable: false,
      failure_reason: 'internal_error',
      recovery_available: false,
    };

    const view = await renderActivation(failed);

    expect(view.getByText(/Contact support before trying again/u)).toBeTruthy();
    expect(view.queryByTestId('retry-vault-activation')).toBeNull();
    expect(view.queryByTestId('recover-vault-activation')).toBeNull();
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

    await settle();
    expect(view.getByTestId('activation-load-error')).toBeTruthy();
    expect(view.getByText(/Your journal still works/u)).toBeTruthy();
  });
});

/** The stack header's title for this screen, as `RootStack.tsx` sets it. */
const NAV_TITLE = 'Create managed vault';
/** The paraphrase the body used to paint under it (#2995). */
const RETIRED_BODY_TITLE = 'Create your managed vault';
const EYEBROW = 'OPTIONAL STORAGE';
const LEAD = 'An account-scoped managed cloud vault, activated only when you choose.';

describe('PrivateVaultActivationScreen — navigation owns the title (#2962)', () => {
  // Not the consent stage: its primary button is labelled NAV_TITLE, which is
  // an action, not a second title.
  it.each([
    ['intro', INACTIVE],
    ['unavailable', { ...INACTIVE, new_activation_available: false }],
  ] as const)(
    'paints no body title under the "Create managed vault" stack header on the %s stage, adds no header, and moves no focus',
    async (_stage, status) => {
      const focus = watchFocusMoves();
      const view = await renderActivation(status);

      expect(view.queryByText(RETIRED_BODY_TITLE)).toBeNull();
      expect(view.queryAllByRole('header')).toHaveLength(0);
      expectNavigationOwnsTitle(view, NAV_TITLE);
      focus.expectNone();
    },
  );

  it('keeps the eyebrow and lead as ordinary text', async () => {
    const view = await renderActivation();

    expect(view.getByText(EYEBROW).props.accessibilityRole).toBeUndefined();
    expect(view.getByText(LEAD).props.accessibilityRole).toBeUndefined();
  });
});
