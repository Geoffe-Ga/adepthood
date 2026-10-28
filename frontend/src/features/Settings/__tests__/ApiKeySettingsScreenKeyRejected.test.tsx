/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

import ApiKeySettingsScreen from '../ApiKeySettingsScreen';
import { KEY_REJECTED_NOTICE } from '../byokOnlyCopy';

import { useApiKey } from '@/context/ApiKeyContext';

/**
 * A managed vault's classification stopped because the writer's provider
 * refused their key (Creek contract 0.26, #3595). The key screen -- the one
 * place a key is replaced -- says so calmly, from the server's boolean alone:
 * no key material and no vendor text ever reach this copy.
 */

jest.mock('@/context/ApiKeyContext', () => ({ useApiKey: jest.fn() }));

const mockConnection = jest.fn();
jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return { ...actual, vault: { connection: () => mockConnection() } };
});

const mockUseApiKey = useApiKey as jest.MockedFunction<typeof useApiKey>;
const STORED_KEY = 'sk-ant-lane-rejected-example-key-0000'; // pragma: allowlist secret

beforeEach(() => {
  mockConnection.mockReset();
  mockUseApiKey.mockReturnValue({
    apiKey: STORED_KEY,
    isLoading: false,
    loadError: null,
    saveApiKey: jest.fn(() => Promise.resolve({ persisted: true })),
    clearApiKey: jest.fn(() => Promise.resolve({ cleared: true })),
    localModel: false,
    setLocalModel: jest.fn(() => Promise.resolve({ persisted: true })),
  } as unknown as ReturnType<typeof useApiKey>);
});

function answer(classificationKeyRejected?: boolean): void {
  mockConnection.mockResolvedValue({
    connected: true,
    vault_url: null,
    mcp_address: null,
    ...(classificationKeyRejected === undefined
      ? {}
      : { classification_key_rejected: classificationKeyRejected }),
  });
}

describe('a refused writer key on the key screen', () => {
  test('says the provider turned the key down and how to replace it', async () => {
    answer(true);
    const { findByTestId } = render(<ApiKeySettingsScreen />);

    const notice = await findByTestId('key-rejected-notice');

    expect(notice).toHaveTextContent(KEY_REJECTED_NOTICE);
  });

  test.each([false, undefined])('says nothing when the server answers %s', async (flag) => {
    answer(flag);
    const { queryByTestId } = render(<ApiKeySettingsScreen />);

    await waitFor(() => expect(mockConnection).toHaveBeenCalledTimes(1));
    expect(queryByTestId('key-rejected-notice')).toBeNull();
  });

  test('says nothing when the read fails', async () => {
    mockConnection.mockRejectedValue(new Error('offline'));
    const { queryByTestId } = render(<ApiKeySettingsScreen />);

    await waitFor(() => expect(mockConnection).toHaveBeenCalledTimes(1));
    expect(queryByTestId('key-rejected-notice')).toBeNull();
  });

  test('the notice is calm, names the remedy, and carries no key or vendor text', () => {
    expect(KEY_REJECTED_NOTICE).toMatch(/replace|paste/i);
    expect(KEY_REJECTED_NOTICE).not.toContain(STORED_KEY);
    expect(KEY_REJECTED_NOTICE).not.toMatch(/\b(401|403|unauthori[sz]ed|forbidden|error)\b/i);
    expect(KEY_REJECTED_NOTICE).not.toMatch(/!|urgent|immediately|warning/i);
  });
});
