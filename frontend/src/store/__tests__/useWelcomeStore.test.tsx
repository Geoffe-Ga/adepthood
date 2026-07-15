import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

// useFirstRun is server-first, falling back to the local cache above only when
// the GET rejects.
jest.mock('@/api', () => ({
  __esModule: true,
  uiFlags: {
    get: jest.fn(),
    update: jest.fn(),
  },
}));

const mockAsyncStorage = jest.requireMock('@react-native-async-storage/async-storage') as {
  setItem: jest.Mock<(_key: string, _value: string) => Promise<void>>;
  getItem: jest.Mock<(_key: string) => Promise<string | null>>;
  removeItem: jest.Mock<(_key: string) => Promise<void>>;
};

interface MockUiFlagsState {
  has_seen_welcome: boolean;
  energy_scaffolding_archived: boolean;
}

const mockUiFlags = (jest.requireMock('@/api') as { uiFlags: unknown }).uiFlags as {
  get: jest.Mock<(_token?: string) => Promise<MockUiFlagsState>>;
  update: jest.Mock<
    (_partial: Partial<MockUiFlagsState>, _token?: string) => Promise<MockUiFlagsState>
  >;
};

import { useFirstRun, useWelcomeStore } from '../useWelcomeStore';

beforeEach(() => {
  jest.clearAllMocks();
  mockAsyncStorage.getItem.mockResolvedValue(null);
  // Default: no server hydration source, so `useFirstRun` falls back to the
  // local cache exactly as before this issue landed. Individual tests below
  // override with a resolved value to exercise the server-first path.
  mockUiFlags.get.mockRejectedValue(new Error('no server hydration configured'));
  mockUiFlags.update.mockResolvedValue({
    has_seen_welcome: true,
    energy_scaffolding_archived: false,
  });
  act(() => {
    useWelcomeStore.setState({ hasSeenWelcome: null });
  });
});

describe('useFirstRun', () => {
  it('returns isFirstRun true once the flag hydrates to unset', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useFirstRun());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.isFirstRun).toBe(true);
  });

  it('returns isFirstRun false once the flag is set (returning user)', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('true');
    const { result } = renderHook(() => useFirstRun());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.isFirstRun).toBe(false);
  });

  it('markSeen persists the flag and flips isFirstRun to false', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useFirstRun());
    await waitFor(() => expect(result.current.isFirstRun).toBe(true));
    act(() => result.current.markSeen());
    expect(result.current.isFirstRun).toBe(false);
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith('@adepthood/has_seen_welcome', 'true');
  });
});

describe('useWelcomeStore.reset', () => {
  it('clears the flag in memory and storage', () => {
    act(() => {
      useWelcomeStore.getState().hydrateHasSeenWelcome(true);
      useWelcomeStore.getState().reset();
    });
    expect(useWelcomeStore.getState().hasSeenWelcome).toBeNull();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/has_seen_welcome');
  });

  // Regression guard: reset() must stay a purely local wipe. Routing it through
  // uiFlags.update would flip has_seen_welcome back to false server-side on
  // every logout, replaying the welcome intro for every account on the device.
  it('never calls uiFlags.update', () => {
    act(() => {
      useWelcomeStore.getState().hydrateHasSeenWelcome(true);
      useWelcomeStore.getState().reset();
    });
    expect(mockUiFlags.update).not.toHaveBeenCalled();
  });
});

describe('useFirstRun — server hydration', () => {
  it('hydrates false and re-seeds the local cache when the server reports true', async () => {
    mockUiFlags.get.mockResolvedValueOnce({
      has_seen_welcome: true,
      energy_scaffolding_archived: false,
    });
    const { result } = renderHook(() => useFirstRun('server-tok'));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.isFirstRun).toBe(false);
    // Brave-wipe scenario: local cache is empty, but the server is the
    // source of truth, so the local cache is re-seeded to match it.
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith('@adepthood/has_seen_welcome', 'true');
  });

  it('hydrates true and clears the local cache when the server reports false', async () => {
    mockUiFlags.get.mockResolvedValueOnce({
      has_seen_welcome: false,
      energy_scaffolding_archived: false,
    });
    const { result } = renderHook(() => useFirstRun('server-tok'));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.isFirstRun).toBe(true);
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/has_seen_welcome');
  });

  it('falls back to the local cache when the server GET rejects', async () => {
    mockUiFlags.get.mockRejectedValueOnce(new Error('network unreachable'));
    mockAsyncStorage.getItem.mockResolvedValueOnce('true');
    const { result } = renderHook(() => useFirstRun('server-tok'));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.isFirstRun).toBe(false);
    // Pins that the server path was actually attempted (with the token) before
    // the fallback ran, not that the hook skipped straight to local storage.
    expect(mockUiFlags.get).toHaveBeenCalledWith('server-tok');
  });

  it('markSeen flips state synchronously and fires uiFlags.update with the token, best-effort', async () => {
    mockUiFlags.get.mockRejectedValueOnce(new Error('network unreachable'));
    const { result } = renderHook(() => useFirstRun('server-tok'));
    await waitFor(() => expect(result.current.isFirstRun).toBe(true));

    act(() => result.current.markSeen());

    expect(result.current.isFirstRun).toBe(false);
    expect(mockUiFlags.update).toHaveBeenCalledWith({ has_seen_welcome: true }, 'server-tok');
  });

  it('markSeen state stays true and warns when uiFlags.update rejects', async () => {
    mockUiFlags.get.mockRejectedValueOnce(new Error('network unreachable'));
    mockUiFlags.update.mockRejectedValueOnce(new Error('server unreachable'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { result } = renderHook(() => useFirstRun('server-tok'));
    await waitFor(() => expect(result.current.isFirstRun).toBe(true));

    act(() => result.current.markSeen());
    expect(result.current.isFirstRun).toBe(false);

    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    warnSpy.mockRestore();
  });
});
