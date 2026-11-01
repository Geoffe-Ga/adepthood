/* global describe, test, expect, beforeEach, jest */
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import { checkedAtSentence, ManagedVaultReachability } from '../ManagedVaultReachability';
import {
  VAULT_CHECKING_BUTTON,
  VAULT_CHECK_NOW_BUTTON,
  VAULT_CHECK_TOO_SOON,
  VAULT_REACHABILITY_UNKNOWN,
  VAULT_REACHABLE,
  VAULT_UNREACHABLE,
} from '../vaultCopy';

import { ApiError, vault, type VaultReachabilityAnswer } from '@/api';
import { settle } from '@/testing/asyncSettle';
import { detectDeviceTimezone, formatTimeInTZ } from '@/utils/dateUtils';

/**
 * "Check now" on the managed vault card (#3406).
 *
 * The Creek pilot was down for two days while this card said "connected". The
 * control lets a writer ask whether the vault answers right now: one press, one
 * handshake, one plain sentence with the time it was asked. Nothing runs on
 * its own, so opening the screen never wakes a stopped vault.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return { ...actual, vault: { checkReachability: jest.fn() } };
});

const mockCheck = vault.checkReachability as jest.MockedFunction<typeof vault.checkReachability>;

const CHECKED_AT = '2026-10-31T11:24:00Z';
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

const expectedTime = formatTimeInTZ(new Date(CHECKED_AT), detectDeviceTimezone());

function answer(state: VaultReachabilityAnswer['state']): VaultReachabilityAnswer {
  return { state, checked_at: CHECKED_AT };
}

interface Settlers {
  resolve: (value: VaultReachabilityAnswer) => void;
  reject: (reason: unknown) => void;
}

async function pressCheck(view: ReturnType<typeof render>) {
  fireEvent.press(view.getByTestId('vault-check-now'));
  await settle();
}

beforeEach(() => {
  mockCheck.mockReset();
});

describe('ManagedVaultReachability', () => {
  test('never checks on its own: opening the card dials nothing', async () => {
    const view = render(<ManagedVaultReachability />);
    await settle();

    expect(mockCheck).not.toHaveBeenCalled();
    expect(view.getByText(VAULT_CHECK_NOW_BUTTON)).toBeTruthy();
    expect(view.queryByTestId('vault-reachability-result')).toBeNull();
  });

  test.each([
    ['reachable', VAULT_REACHABLE],
    ['unreachable', VAULT_UNREACHABLE],
    ['unknown', VAULT_REACHABILITY_UNKNOWN],
  ] as const)('a %s answer reads as one sentence with the time checked', async (state, copy) => {
    mockCheck.mockResolvedValueOnce(answer(state));
    const view = render(<ManagedVaultReachability />);

    await pressCheck(view);

    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(within(view.getByTestId('vault-reachability-result')).getByText(copy)).toBeTruthy();
    expect(view.getByText(`Checked ${expectedTime}.`)).toBeTruthy();
  });

  test('shows a pending state while the check is out, and takes no second press', async () => {
    let resolve: (value: VaultReachabilityAnswer) => void = () => undefined;
    mockCheck.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<ManagedVaultReachability />);

    fireEvent.press(view.getByTestId('vault-check-now'));
    await settle();

    expect(view.getByText(VAULT_CHECKING_BUTTON)).toBeTruthy();
    expect(view.getByTestId('vault-check-now').props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
    fireEvent.press(view.getByTestId('vault-check-now'));
    expect(mockCheck).toHaveBeenCalledTimes(1);

    resolve(answer('reachable'));
    await settle();
    expect(view.getByText(VAULT_REACHABLE)).toBeTruthy();
    expect(view.getByText(VAULT_CHECK_NOW_BUTTON)).toBeTruthy();
  });

  test('a check refused for its budget says to wait, with no time it never checked', async () => {
    mockCheck.mockRejectedValueOnce(new ApiError(HTTP_TOO_MANY_REQUESTS, 'rate_limited'));
    const view = render(<ManagedVaultReachability />);

    await pressCheck(view);

    expect(view.getByText(VAULT_CHECK_TOO_SOON)).toBeTruthy();
    expect(view.queryByText(/^Checked /u)).toBeNull();
  });

  test('a check that could not be asked reads as "couldn\'t tell", never as an outage', async () => {
    mockCheck.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'internal_error'));
    const view = render(<ManagedVaultReachability />);

    await pressCheck(view);

    expect(view.getByText(VAULT_REACHABILITY_UNKNOWN)).toBeTruthy();
    expect(view.queryByText(VAULT_UNREACHABLE)).toBeNull();
    expect(view.queryByText(/^Checked /u)).toBeNull();
  });

  test('a later press replaces the earlier answer', async () => {
    mockCheck
      .mockResolvedValueOnce(answer('unreachable'))
      .mockResolvedValueOnce(answer('reachable'));
    const view = render(<ManagedVaultReachability />);

    await pressCheck(view);
    expect(view.getByText(VAULT_UNREACHABLE)).toBeTruthy();
    await pressCheck(view);

    expect(view.queryByText(VAULT_UNREACHABLE)).toBeNull();
    expect(view.getByText(VAULT_REACHABLE)).toBeTruthy();
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['answers', (settleWith: Settlers) => settleWith.resolve(answer('reachable'))],
    ['fails', (settleWith: Settlers) => settleWith.reject(new ApiError(HTTP_SERVER_ERROR, 'x'))],
  ] as const)('a check that %s after the card is gone lands nothing', async (_label, finish) => {
    const settlers: Settlers = { resolve: () => undefined, reject: () => undefined };
    mockCheck.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        settlers.resolve = resolve;
        settlers.reject = reject;
      }),
    );
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(<ManagedVaultReachability />);
    fireEvent.press(view.getByTestId('vault-check-now'));
    view.unmount();

    finish(settlers);
    await settle();

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  test('the result is announced politely to assistive technology', async () => {
    mockCheck.mockResolvedValueOnce(answer('reachable'));
    const view = render(<ManagedVaultReachability />);

    await pressCheck(view);

    expect(view.getByTestId('vault-reachability-result').props.accessibilityLiveRegion).toBe(
      'polite',
    );
  });
});

describe('checkedAtSentence', () => {
  test('names the device-local time the vault was checked', () => {
    expect(checkedAtSentence(CHECKED_AT)).toBe(`Checked ${expectedTime}.`);
  });
});
