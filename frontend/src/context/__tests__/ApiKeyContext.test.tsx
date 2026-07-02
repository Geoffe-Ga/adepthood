/* eslint-env jest */
/* global describe, test, expect, jest, beforeEach */
import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import * as apiModule from '@/api';
import { ApiKeyProvider, useApiKey } from '@/context/ApiKeyContext';
import * as llmKeyStorage from '@/storage/llmKeyStorage';

jest.mock('@/api', () => ({
  setLlmApiKeyGetter: jest.fn(),
}));

jest.mock('@/storage/llmKeyStorage', () => ({
  loadLlmApiKey: jest.fn(() => Promise.resolve(null)),
  saveLlmApiKey: jest.fn(() => Promise.resolve()),
  clearLlmApiKey: jest.fn(() => Promise.resolve()),
}));

const mockApi = apiModule as jest.Mocked<typeof apiModule>;
const mockStorage = llmKeyStorage as jest.Mocked<typeof llmKeyStorage>;

function TestConsumer({
  onValue,
}: {
  onValue: (_v: ReturnType<typeof useApiKey>) => void;
}): React.JSX.Element {
  const ctx = useApiKey();
  onValue(ctx);
  return <Text>{ctx.apiKey ?? '(none)'}</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStorage.loadLlmApiKey.mockResolvedValue(null);
});

describe('ApiKeyProvider', () => {
  test('loads the stored key from SecureStore on mount', async () => {
    mockStorage.loadLlmApiKey.mockResolvedValueOnce('sk-stored');
    const captured: Array<ReturnType<typeof useApiKey>> = [];

    const view = render(
      <ApiKeyProvider>
        <TestConsumer onValue={(v) => captured.push(v)} />
      </ApiKeyProvider>,
    );

    await waitFor(() => expect(view.getByText('sk-stored')).toBeTruthy());
    const last = captured[captured.length - 1];
    expect(last).toBeDefined();
    expect(last!.isLoading).toBe(false);
  });

  test('registers an API-layer getter that returns the current key', async () => {
    mockStorage.loadLlmApiKey.mockResolvedValueOnce('sk-alpha');

    render(
      <ApiKeyProvider>
        <TestConsumer onValue={() => undefined} />
      </ApiKeyProvider>,
    );

    await waitFor(() => expect(mockApi.setLlmApiKeyGetter).toHaveBeenCalled());
    const firstCall = mockApi.setLlmApiKeyGetter.mock.calls[0];
    expect(firstCall).toBeDefined();
    const registered = firstCall![0];
    expect(registered).not.toBeNull();
    await waitFor(() => expect(registered?.()).toBe('sk-alpha'));
  });

  test('saveApiKey persists and updates state', async () => {
    let ctx: ReturnType<typeof useApiKey> | null = null;
    render(
      <ApiKeyProvider>
        <TestConsumer
          onValue={(v) => {
            ctx = v;
          }}
        />
      </ApiKeyProvider>,
    );
    await waitFor(() => expect(ctx?.isLoading).toBe(false));

    await act(async () => {
      await ctx!.saveApiKey('sk-new');
    });

    expect(mockStorage.saveLlmApiKey).toHaveBeenCalledWith('sk-new');
    expect(ctx!.apiKey).toBe('sk-new');
  });

  test('clearApiKey deletes the stored key and resets state', async () => {
    mockStorage.loadLlmApiKey.mockResolvedValueOnce('sk-existing');
    let ctx: ReturnType<typeof useApiKey> | null = null;
    render(
      <ApiKeyProvider>
        <TestConsumer
          onValue={(v) => {
            ctx = v;
          }}
        />
      </ApiKeyProvider>,
    );
    await waitFor(() => expect(ctx?.apiKey).toBe('sk-existing'));

    await act(async () => {
      await ctx!.clearApiKey();
    });

    expect(mockStorage.clearLlmApiKey).toHaveBeenCalled();
    expect(ctx!.apiKey).toBeNull();
  });

  test('useApiKey throws when used outside a provider', () => {
    const suppress = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const NakedConsumer = (): React.JSX.Element => {
      useApiKey();
      return <Text>never</Text>;
    };
    expect(() => render(<NakedConsumer />)).toThrow(/ApiKeyProvider/);
    suppress.mockRestore();
  });

  test('sets loadError when the initial SecureStore read fails', async () => {
    mockStorage.loadLlmApiKey.mockRejectedValueOnce(new Error('keychain locked'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let ctx: ReturnType<typeof useApiKey> | null = null;
    render(
      <ApiKeyProvider>
        <TestConsumer
          onValue={(v) => {
            ctx = v;
          }}
        />
      </ApiKeyProvider>,
    );

    await waitFor(() => expect(ctx?.isLoading).toBe(false));

    expect(ctx!.apiKey).toBeNull();
    expect(ctx!.loadError).toBeInstanceOf(Error);
    expect(ctx!.loadError?.message).toBe('keychain locked');
    warnSpy.mockRestore();
  });

  test('wraps a non-Error thrown value from the initial load in an Error', async () => {
    mockStorage.loadLlmApiKey.mockRejectedValueOnce('string rejection');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let ctx: ReturnType<typeof useApiKey> | null = null;
    render(
      <ApiKeyProvider>
        <TestConsumer
          onValue={(v) => {
            ctx = v;
          }}
        />
      </ApiKeyProvider>,
    );

    await waitFor(() => expect(ctx?.isLoading).toBe(false));

    expect(ctx!.loadError).toBeInstanceOf(Error);
    expect(ctx!.loadError?.message).toBe('string rejection');
    warnSpy.mockRestore();
  });

  test('saveApiKey sets loadError but still updates the key when the write fails', async () => {
    mockStorage.saveLlmApiKey.mockRejectedValueOnce(new Error('disk full'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let ctx: ReturnType<typeof useApiKey> | null = null;
    render(
      <ApiKeyProvider>
        <TestConsumer
          onValue={(v) => {
            ctx = v;
          }}
        />
      </ApiKeyProvider>,
    );
    await waitFor(() => expect(ctx?.isLoading).toBe(false));

    await act(async () => {
      await ctx!.saveApiKey('sk-fallback');
    });

    expect(ctx!.loadError).toBeInstanceOf(Error);
    expect(ctx!.loadError?.message).toBe('disk full');
    expect(ctx!.apiKey).toBe('sk-fallback');
    warnSpy.mockRestore();
  });

  test('clearApiKey sets loadError but still nulls the key when the clear fails', async () => {
    mockStorage.loadLlmApiKey.mockResolvedValueOnce('sk-existing');
    mockStorage.clearLlmApiKey.mockRejectedValueOnce(new Error('locked'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let ctx: ReturnType<typeof useApiKey> | null = null;
    render(
      <ApiKeyProvider>
        <TestConsumer
          onValue={(v) => {
            ctx = v;
          }}
        />
      </ApiKeyProvider>,
    );
    await waitFor(() => expect(ctx?.apiKey).toBe('sk-existing'));

    await act(async () => {
      await ctx!.clearApiKey();
    });

    expect(ctx!.loadError).toBeInstanceOf(Error);
    expect(ctx!.loadError?.message).toBe('locked');
    expect(ctx!.apiKey).toBeNull();
    warnSpy.mockRestore();
  });
});
