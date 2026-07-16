/* eslint-env jest */
/* global describe, test, expect, jest, beforeEach */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';

import ApiKeySettingsScreen, { SECURE_STORAGE_WARNING } from '../ApiKeySettingsScreen';

import { ApiKeyProvider } from '@/context/ApiKeyContext';
import * as llmKeyStorage from '@/storage/llmKeyStorage';

const VALID_KEY = 'sk-user-owned-example-key-0123456789';

jest.mock('@/api', () => ({
  setLlmApiKeyGetter: jest.fn(),
  setLlmApiKeyReset: jest.fn(),
}));

jest.mock('@/storage/llmKeyStorage', () => ({
  loadLlmApiKey: jest.fn(() => Promise.resolve(null)),
  saveLlmApiKey: jest.fn(() => Promise.resolve()),
  clearLlmApiKey: jest.fn(() => Promise.resolve()),
}));

const mockStorage = llmKeyStorage as jest.Mocked<typeof llmKeyStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ApiKeySettingsScreen integration with a failing SecureStore read', () => {
  test('shows the storage-unavailable warning once the real provider load rejects', async () => {
    mockStorage.loadLlmApiKey.mockRejectedValueOnce(new Error('keychain locked'));
    const warnSpy = jest.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined);

    const { getByTestId, queryByTestId } = render(
      <ApiKeyProvider>
        <ApiKeySettingsScreen />
      </ApiKeyProvider>,
    );

    expect(getByTestId('api-key-loading')).toBeTruthy();
    await waitFor(() => expect(queryByTestId('api-key-loading')).toBeNull());

    expect(getByTestId('api-key-storage-error').props.children).toBe(SECURE_STORAGE_WARNING);
    warnSpy.mockRestore();
  });
});

describe('ApiKeySettingsScreen integration with a failing SecureStore write', () => {
  test('shows only the storage warning, not a false success status, when the save write fails', async () => {
    mockStorage.saveLlmApiKey.mockRejectedValueOnce(new Error('keychain locked'));
    const warnSpy = jest.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined);

    const { getByTestId, findByTestId, queryByTestId } = render(
      <ApiKeyProvider>
        <ApiKeySettingsScreen />
      </ApiKeyProvider>,
    );

    await waitFor(() => expect(queryByTestId('api-key-loading')).toBeNull());
    fireEvent.changeText(getByTestId('api-key-input'), VALID_KEY);
    await act(async () => {
      fireEvent.press(getByTestId('save-key-button'));
    });

    const warning = await findByTestId('api-key-storage-error');
    expect(warning.props.children).toBe(SECURE_STORAGE_WARNING);
    expect(queryByTestId('api-key-status')).toBeNull();
    expect(queryByTestId('api-key-error')).toBeNull();
    warnSpy.mockRestore();
  });

  test('shows the success status and no storage warning when the save write succeeds', async () => {
    const { getByTestId, findByTestId, queryByTestId } = render(
      <ApiKeyProvider>
        <ApiKeySettingsScreen />
      </ApiKeyProvider>,
    );

    await waitFor(() => expect(queryByTestId('api-key-loading')).toBeNull());
    fireEvent.changeText(getByTestId('api-key-input'), VALID_KEY);
    await act(async () => {
      fireEvent.press(getByTestId('save-key-button'));
    });

    const status = await findByTestId('api-key-status');
    expect(status).toBeTruthy();
    expect(queryByTestId('api-key-storage-error')).toBeNull();
  });
});

describe('ApiKeySettingsScreen integration with a failing SecureStore delete', () => {
  test('shows only the storage warning, not a false removed status, when the clear delete fails', async () => {
    mockStorage.loadLlmApiKey.mockResolvedValueOnce(VALID_KEY);
    mockStorage.clearLlmApiKey.mockRejectedValueOnce(new Error('keychain locked'));
    const warnSpy = jest.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      const destructive = buttons?.find((b) => b.style === 'destructive');
      destructive?.onPress?.();
    });

    const { getByTestId, findByTestId, queryByTestId } = render(
      <ApiKeyProvider>
        <ApiKeySettingsScreen />
      </ApiKeyProvider>,
    );

    await waitFor(() => expect(queryByTestId('api-key-loading')).toBeNull());
    await act(async () => {
      fireEvent.press(getByTestId('remove-key-button'));
    });

    const warning = await findByTestId('api-key-storage-error');
    expect(warning.props.children).toBe(SECURE_STORAGE_WARNING);
    expect(queryByTestId('api-key-status')).toBeNull();
    expect(queryByTestId('api-key-error')).toBeNull();
    alertSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('shows the removed status and no storage warning when the clear delete succeeds', async () => {
    mockStorage.loadLlmApiKey.mockResolvedValueOnce(VALID_KEY);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      const destructive = buttons?.find((b) => b.style === 'destructive');
      destructive?.onPress?.();
    });

    const { getByTestId, findByTestId, queryByTestId } = render(
      <ApiKeyProvider>
        <ApiKeySettingsScreen />
      </ApiKeyProvider>,
    );

    await waitFor(() => expect(queryByTestId('api-key-loading')).toBeNull());
    await act(async () => {
      fireEvent.press(getByTestId('remove-key-button'));
    });

    const status = await findByTestId('api-key-status');
    expect(status).toBeTruthy();
    expect(queryByTestId('api-key-storage-error')).toBeNull();
    alertSpy.mockRestore();
  });
});
