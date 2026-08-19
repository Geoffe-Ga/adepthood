/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import DeleteAccountScreen from '../DeleteAccountScreen';

import { ApiError, users, type AccountDeletionReceipt } from '@/api';
import { useAuth } from '@/context/AuthContext';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return { ...actual, users: { deleteMyAccount: jest.fn() } };
});

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockDeleteMyAccount = users.deleteMyAccount as jest.MockedFunction<
  typeof users.deleteMyAccount
>;

const RECEIPT: AccountDeletionReceipt = {
  recoverable: false,
  rows_erased: 42,
  erased: ['habit', 'journalentry'],
  anonymised: ['practice'],
  retained: ['coursestage'],
  vault: {
    configured: true,
    purged: false,
    guidance: 'Your Creek Vault is yours, not ours. Run `creek purge` against it.',
  },
};

function setAuthState() {
  const logout = jest.fn(() => Promise.resolve());
  mockUseAuth.mockReturnValue({ logout } as unknown as ReturnType<typeof useAuth>);
  return { logout };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DeleteAccountScreen', () => {
  test('states that the deletion is immediate and irreversible before anything is typed', () => {
    setAuthState();

    const { getByTestId } = render(<DeleteAccountScreen />);

    const warning = getByTestId('delete-account-warning').props.children as string;
    expect(warning).toContain('irreversible');
    expect(warning).toContain('no grace period');
  });

  test('lists both what is erased and what deliberately survives', () => {
    setAuthState();

    const { getByTestId } = render(<DeleteAccountScreen />);

    expect(getByTestId('delete-account-erased')).toBeTruthy();
    expect(getByTestId('delete-account-retained')).toBeTruthy();
  });

  test('refuses to call the API until a confirmation is typed', async () => {
    setAuthState();
    const { getByTestId } = render(<DeleteAccountScreen />);

    fireEvent.press(getByTestId('delete-account-submit'));

    await waitFor(() => expect(getByTestId('delete-account-error')).toBeTruthy());
    expect(mockDeleteMyAccount).not.toHaveBeenCalled();
  });

  test('sends the typed address, trimmed, as the confirmation', async () => {
    setAuthState();
    mockDeleteMyAccount.mockResolvedValue(RECEIPT);
    const { getByTestId } = render(<DeleteAccountScreen />);

    fireEvent.changeText(getByTestId('delete-account-email-input'), '  writer@example.com ');
    fireEvent.press(getByTestId('delete-account-submit'));

    await waitFor(() =>
      expect(mockDeleteMyAccount).toHaveBeenCalledWith({ confirm_email: 'writer@example.com' }),
    );
  });

  test('shows the vault guidance the server returned rather than local prose', async () => {
    setAuthState();
    mockDeleteMyAccount.mockResolvedValue(RECEIPT);
    const { getByTestId } = render(<DeleteAccountScreen />);

    fireEvent.changeText(getByTestId('delete-account-email-input'), 'writer@example.com');
    fireEvent.press(getByTestId('delete-account-submit'));

    await waitFor(() => expect(getByTestId('delete-account-receipt')).toBeTruthy());
    expect(getByTestId('delete-account-vault-guidance').props.children).toBe(
      RECEIPT.vault.guidance,
    );
  });

  test('clears the local session only once the server has confirmed', async () => {
    const { logout } = setAuthState();
    mockDeleteMyAccount.mockResolvedValue(RECEIPT);
    const { getByTestId } = render(<DeleteAccountScreen />);

    fireEvent.changeText(getByTestId('delete-account-email-input'), 'writer@example.com');
    fireEvent.press(getByTestId('delete-account-submit'));
    await waitFor(() => expect(getByTestId('delete-account-done')).toBeTruthy());
    expect(logout).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('delete-account-done'));

    expect(logout).toHaveBeenCalled();
  });

  test('a mismatched confirmation says nothing was deleted and keeps the session', async () => {
    const { logout } = setAuthState();
    mockDeleteMyAccount.mockRejectedValue(new ApiError(400, 'confirmation_email_mismatch'));
    const { getByTestId, queryByTestId } = render(<DeleteAccountScreen />);

    fireEvent.changeText(getByTestId('delete-account-email-input'), 'someone.else@example.com');
    fireEvent.press(getByTestId('delete-account-submit'));

    await waitFor(() => expect(getByTestId('delete-account-error')).toBeTruthy());
    expect(getByTestId('delete-account-error').props.children).toContain(
      'Nothing has been deleted',
    );
    expect(queryByTestId('delete-account-receipt')).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });
});
