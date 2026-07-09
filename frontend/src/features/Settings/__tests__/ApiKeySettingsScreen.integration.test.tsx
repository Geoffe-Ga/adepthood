/* eslint-env jest */
/* global describe, test, expect, jest, beforeEach */
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

import ApiKeySettingsScreen, { SECURE_STORAGE_WARNING } from '../ApiKeySettingsScreen';

import { ApiKeyProvider } from '@/context/ApiKeyContext';
import * as llmKeyStorage from '@/storage/llmKeyStorage';

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
