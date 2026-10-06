/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { renderHook, waitFor } from '@testing-library/react-native';

import {
  fetchVaultConnectionState,
  readVaultConnection,
  useVaultConnectionState,
} from '../useVaultConnectionState';

/**
 * The one read of `GET /vault/connection` every surface shares (#3017).
 *
 * The hub, the band, the drawer and the seeding screen all gate "Bring in your
 * writing" on it, and Where your writing lives renders from it, so its answer
 * has to mean the same thing everywhere: unknown until the server says
 * otherwise, and unknown again when the server could not be reached -- never
 * "nothing attached", which would send somebody with a vault off to set one up.
 */

const mockConnection = jest.fn();

jest.mock('@/api', () => ({
  vault: { connection: (...args: unknown[]) => mockConnection(...args) },
}));

/** A promise that never settles, standing in for a read still in flight. */
function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

beforeEach(() => {
  mockConnection.mockReset();
});

describe('useVaultConnectionState', () => {
  test('starts unknown and loading, before any answer', () => {
    mockConnection.mockReturnValue(never());

    const { result } = renderHook(() => useVaultConnectionState());

    expect(result.current.state).toEqual({ kind: 'unknown' });
    expect(result.current.loading).toBe(true);
  });

  test('reads an account with nothing attached as none', async () => {
    mockConnection.mockResolvedValue({ connected: false, vault_url: null });

    const { result } = renderHook(() => useVaultConnectionState());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toEqual({ kind: 'none' });
  });

  test('reads a vault at an address as connected', async () => {
    mockConnection.mockResolvedValue({ connected: true, vault_url: 'https://v.example' });

    const { result } = renderHook(() => useVaultConnectionState());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toEqual({ kind: 'connected', address: 'https://v.example' });
  });

  test('reads a managed vault, answered with no address, as unknown', async () => {
    mockConnection.mockResolvedValue({ connected: true, vault_url: null });

    const { result } = renderHook(() => useVaultConnectionState());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toEqual({ kind: 'unknown' });
  });

  test('reads a failed read as unknown, never as none, and reports it once', async () => {
    mockConnection.mockRejectedValue(new Error('offline'));
    const onError = jest.fn();

    const { result } = renderHook(() => useVaultConnectionState(onError));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toEqual({ kind: 'unknown' });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('reports nothing and sets nothing once it has been unmounted', async () => {
    let fail: (reason: Error) => void = () => undefined;
    mockConnection.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const onError = jest.fn();

    const { result, unmount } = renderHook(() => useVaultConnectionState(onError));
    unmount();
    fail(new Error('late'));
    // A macrotask, so every promise hop between the rejection and the hook's
    // handlers has run before anything is asserted.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: 'unknown' });
  });

  test('reads once across rerenders, even when the error handler changes', async () => {
    mockConnection.mockResolvedValue({ connected: false, vault_url: null });

    const { result, rerender } = renderHook(
      ({ handler }: { handler: () => void }) => useVaultConnectionState(handler),
      { initialProps: { handler: jest.fn() } },
    );
    rerender({ handler: jest.fn() });
    rerender({ handler: jest.fn() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockConnection).toHaveBeenCalledTimes(1);
  });

  test('reports a failure to the handler current when it lands', async () => {
    let fail: (reason: Error) => void = () => undefined;
    mockConnection.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const first = jest.fn();
    const second = jest.fn();

    const { result, rerender } = renderHook(
      ({ handler }: { handler: () => void }) => useVaultConnectionState(handler),
      { initialProps: { handler: first } },
    );
    rerender({ handler: second });
    fail(new Error('offline'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('readVaultConnection', () => {
  test('turns a client that throws synchronously into a rejection', async () => {
    mockConnection.mockImplementation(() => {
      throw new Error('no client');
    });

    await expect(readVaultConnection()).rejects.toThrow('no client');
  });
});

describe('fetchVaultConnectionState', () => {
  test('resolves the server answer as a state', async () => {
    mockConnection.mockResolvedValue({ connected: false, vault_url: null });

    await expect(fetchVaultConnectionState()).resolves.toEqual({ kind: 'none' });
  });

  test('never rejects: a failed read resolves unknown', async () => {
    mockConnection.mockRejectedValue(new Error('offline'));

    await expect(fetchVaultConnectionState()).resolves.toEqual({ kind: 'unknown' });
  });
});
